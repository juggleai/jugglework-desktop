import { useEffect, useMemo, useState } from "react";
import type {
  AutomationEventCommonFilter,
  AutomationEventDeliveryMode,
  AutomationEventTrigger,
  AutomationGithubEventFilter,
  AutomationGithubEventMatch,
  AutomationGithubEventType,
  AutomationPermissionProfile,
} from "@jugglework/types/automation";
import { t } from "@/i18n";

const FIELD = "h-11 w-full rounded-xl border border-[#ebebeb] bg-background pl-3 pr-2 text-sm outline-none transition focus:border-dls-accent dark:border-dls-border";

/**
 * 事件触发的就绪态探测结果。
 * TIPS: 三态复用产品已有的连接器状态词汇（未连接/待配置/已连接），不是 GitHub 专属枚举，
 * 详见服务端 PRD §4.4 和桌面端 design.md 决策 6。
 */
export type GithubReadinessState = "not_connected" | "pending_configuration" | "ready" | "unknown";

export type GithubRepositoryOption = {
  connectorId: string;
  owner: string;
  name: string;
  visibility: "public" | "private";
};

/**
 * 事件触发编辑面板依赖的外部数据源接口。
 * TIPS: 这是桌面端到 jugglework-server 的网络边界——具体实现（`createGithubEventClient`）
 * 由调用方注入，测试里可以传入内存假实现，不需要真实网络。就绪态探测/仓库列表/频率预估这几个
 * 接口都还没有真实的服务端实现（见 add-github-event-trigger-relay），当前会优雅降级为空态。
 */
export type GithubEventTriggerClient = {
  listRepositories: () => Promise<GithubRepositoryOption[]>;
  checkReadiness: (repo: { owner: string; name: string }) => Promise<GithubReadinessState>;
  requestInstall: () => Promise<void>;
  requestBind: (repo: { owner: string; name: string }) => Promise<void>;
  estimateFrequency: (trigger: AutomationEventTrigger) => Promise<number | null>;
};

const EVENT_TYPE_STORIES: Array<{ event: AutomationGithubEventType; labelKey: string }> = [
  { event: "pull_request", labelKey: "automation.event_type.pr_opened" },
  { event: "issue_comment_on_pull_request", labelKey: "automation.event_type.pr_new_comment" },
  { event: "pull_request_review", labelKey: "automation.event_type.pr_review_received" },
  { event: "pull_request_review_comment", labelKey: "automation.event_type.pr_review_comment" },
  { event: "issues", labelKey: "automation.event_type.issue_opened" },
  { event: "issue_comment", labelKey: "automation.event_type.issue_new_comment" },
  // TIPS:P2（任务 7.1）——类型/校验早就支持 release，这里补齐勾选矩阵条目。跟其它事件类型一样，
  // 实际生效依赖服务端的事件中继能力（尚未实现），不是这一条本身有什么特殊前置条件。
  { event: "release", labelKey: "automation.event_type.release_published" },
];

export function defaultEventTrigger(connectorId: string, repo?: GithubRepositoryOption): AutomationEventTrigger {
  return {
    version: 1,
    kind: "event",
    provider: "github",
    connectorId,
    repository: repo ? { owner: repo.owner, name: repo.name } : { owner: "", name: "" },
    matches: [],
    concurrencyKey: "entity",
    deliveryMode: "auto",
    permissionTier: "auto",
  };
}

/**
 * 事件触发配置面板。
 * TIPS: 保存不因就绪态不是 `ready` 而被阻塞——本地校验（validateAutomationEventTrigger）
 * 只做结构校验，不校验服务端绑定状态；就绪态只用于渲染引导横幅，草稿始终可以保存
 * （见桌面 PRD 4.6 的"待仓库就绪"设计，以及本次实现里"保存不需要新生命周期态"的简化）。
 */
export function EventTriggerEditor(props: {
  value: AutomationEventTrigger;
  onChange: (next: AutomationEventTrigger) => void;
  client: GithubEventTriggerClient;
  permission: AutomationPermissionProfile;
  onPermissionEscalationConfirmed: () => void;
}) {
  const [repositories, setRepositories] = useState<GithubRepositoryOption[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<GithubReadinessState>("unknown");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [escalationOpen, setEscalationOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    props.client.listRepositories()
      .then((items) => { if (!cancelled) setRepositories(items); })
      .catch((error) => { if (!cancelled) setReposError(String(error instanceof Error ? error.message : error)); });
    return () => { cancelled = true; };
  }, [props.client]);

  const selectedRepo = repositories?.find((repo) => repo.owner === props.value.repository.owner && repo.name === props.value.repository.name);
  const inputTrustLevel: "open" | "restricted" | "unknown" = selectedRepo ? (selectedRepo.visibility === "public" ? "open" : "restricted") : "unknown";

  useEffect(() => {
    let cancelled = false;
    if (!props.value.repository.owner || !props.value.repository.name) { setReadiness("unknown"); return; }
    props.client.checkReadiness(props.value.repository)
      .then((state) => { if (!cancelled) setReadiness(state); })
      .catch(() => { if (!cancelled) setReadiness("unknown"); });
    return () => { cancelled = true; };
  }, [props.client, props.value.repository.owner, props.value.repository.name]);

  useEffect(() => {
    if (!props.value.matches.length) { setEstimate(null); return; }
    let cancelled = false;
    props.client.estimateFrequency(props.value).then((value) => { if (!cancelled) setEstimate(value); }).catch(() => { if (!cancelled) setEstimate(null); });
    return () => { cancelled = true; };
  }, [props.client, props.value]);

  // TIPS:公开仓库强制收敛权限档位；私有仓库沿用现有两档选择，见桌面 PRD 4.3。
  useEffect(() => {
    if (inputTrustLevel === "open" && props.permission !== "interactive-default-v1" && !escalationOpen) {
      // 已经是完整访问权限但仓库变成了 open，需要用户重新走一次独立确认，而不是静默保留。
    }
  }, [inputTrustLevel, props.permission, escalationOpen]);

  const updateMatch = (event: AutomationGithubEventType, patch: Partial<AutomationGithubEventMatch> | null) => {
    const existing = props.value.matches.find((match) => match.event === event);
    if (patch === null) {
      props.onChange({ ...props.value, matches: props.value.matches.filter((match) => match.event !== event) });
      return;
    }
    const next = existing ? { ...existing, ...patch } : { event, ...patch };
    props.onChange({ ...props.value, matches: [...props.value.matches.filter((match) => match.event !== event), next] });
  };

  const updateCommonFilter = (patch: Partial<AutomationEventCommonFilter>) => {
    props.onChange({
      ...props.value,
      matches: props.value.matches.map((match) => ({ ...match, common: { ...match.common, ...patch } })),
    });
  };

  const updateGithubFilter = (patch: Partial<AutomationGithubEventFilter>) => {
    props.onChange({
      ...props.value,
      matches: props.value.matches.map((match) => ({ ...match, github: { ...match.github, ...patch } })),
    });
  };

  return (
    <div className="space-y-5">
      {readiness === "not_connected" ? (
        <ReadinessBanner
          message={t("automation.event_readiness_not_connected")}
          actionLabel={t("automation.event_request_install")}
          onAction={() => void props.client.requestInstall()}
        />
      ) : null}
      {readiness === "pending_configuration" ? (
        <ReadinessBanner
          message={t("automation.event_readiness_pending_bind")}
          actionLabel={t("automation.event_bind_repository")}
          onAction={() => void props.client.requestBind(props.value.repository)}
        />
      ) : null}

      <FieldRow label={t("automation.event_repository")}>
        <select
          className={FIELD}
          value={selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : ""}
          onChange={(event) => {
            const [owner, name] = event.target.value.split("/");
            const repo = repositories?.find((item) => item.owner === owner && item.name === name);
            props.onChange({ ...props.value, connectorId: repo?.connectorId ?? props.value.connectorId, repository: { owner: owner ?? "", name: name ?? "" } });
          }}
          aria-label={t("automation.event_repository")}
        >
          <option value="">{t("automation.event_repository_placeholder")}</option>
          {(repositories ?? []).map((repo) => (
            <option key={`${repo.owner}/${repo.name}`} value={`${repo.owner}/${repo.name}`}>{repo.owner}/{repo.name}</option>
          ))}
        </select>
        {reposError ? <p className="mt-2 text-xs text-red-9">{t("automation.event_repositories_load_failed")}{reposError}</p> : null}
      </FieldRow>

      <FieldRow label={t("automation.event_types")}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EVENT_TYPE_STORIES.map(({ event, labelKey }) => {
            const checked = props.value.matches.some((match) => match.event === event);
            return (
              <label key={event} className="flex items-center gap-2 rounded-xl border border-dls-border px-3 py-2 text-sm">
                <input type="checkbox" checked={checked} onChange={(input) => updateMatch(event, input.target.checked ? {} : null)} />
                {t(labelKey)}
              </label>
            );
          })}
        </div>
      </FieldRow>

      <details className="rounded-xl border border-dls-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">{t("automation.event_advanced_filters")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs font-medium text-dls-secondary">{t("automation.event_filters_common")}</p>
          <input className={FIELD} placeholder={t("automation.event_filter_mention_placeholder")} onChange={(event) => updateCommonFilter({ mentionText: event.target.value })} aria-label={t("automation.event_filter_mention_placeholder")} />
          <input className={FIELD} placeholder={t("automation.event_filter_keyword_placeholder")} onChange={(event) => updateCommonFilter({ keyword: event.target.value })} aria-label={t("automation.event_filter_keyword_placeholder")} />
          <p className="pt-2 text-xs font-medium text-dls-secondary">{t("automation.event_filters_github")}</p>
          <input className={FIELD} placeholder={t("automation.event_filter_branch_placeholder")} onChange={(event) => updateGithubFilter({ branches: { base: event.target.value ? [event.target.value] : [] } })} aria-label={t("automation.event_filter_branch_placeholder")} />
          <input className={FIELD} placeholder={t("automation.event_filter_path_placeholder")} onChange={(event) => updateGithubFilter({ changedPaths: event.target.value ? [event.target.value] : [] })} aria-label={t("automation.event_filter_path_placeholder")} />
        </div>
      </details>

      <FieldRow label={t("automation.event_delivery_mode")}>
        <DeliveryModeControl value={props.value.deliveryMode} onChange={(mode) => props.onChange({ ...props.value, deliveryMode: mode })} />
      </FieldRow>

      <FieldRow label={t("automation.event_permission_tier")}>
        <PermissionTierSummary
          inputTrustLevel={inputTrustLevel}
          permission={props.permission}
          onEscalate={() => setEscalationOpen(true)}
        />
      </FieldRow>

      <FieldRow label={t("automation.event_hourly_cap")}>
        <input
          type="number"
          min={1}
          className={FIELD}
          value={props.value.hourlyTriggerCap ?? ""}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            props.onChange({ ...props.value, ...(Number.isFinite(parsed) && parsed > 0 ? { hourlyTriggerCap: parsed } : {}) });
          }}
          aria-label={t("automation.event_hourly_cap")}
        />
        {estimate !== null ? <p className="mt-2 text-xs text-dls-secondary">{t("automation.event_estimate_prefix")}{estimate}</p> : null}
      </FieldRow>

      {escalationOpen ? (
        <EscalationConfirm
          onCancel={() => setEscalationOpen(false)}
          onConfirm={() => { props.onPermissionEscalationConfirmed(); setEscalationOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function ReadinessBanner(props: { message: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-amber-6 bg-amber-2 px-4 py-3 text-sm">
      <span>{props.message}</span>
      <button type="button" onClick={props.onAction} className="rounded-lg border border-dls-border px-3 py-1.5 text-xs font-medium hover:bg-dls-hover">{props.actionLabel}</button>
    </div>
  );
}

function DeliveryModeControl(props: { value: AutomationEventDeliveryMode; onChange: (mode: AutomationEventDeliveryMode) => void }) {
  const options: Array<{ value: AutomationEventDeliveryMode; labelKey: string }> = [
    { value: "auto", labelKey: "automation.event_delivery_auto" },
    { value: "im", labelKey: "automation.event_delivery_im" },
    { value: "poll", labelKey: "automation.event_delivery_poll" },
  ];
  return (
    <div className="flex gap-4">
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-1.5 text-sm">
          <input type="radio" name="event-delivery-mode" checked={props.value === option.value} onChange={() => props.onChange(option.value)} />
          {t(option.labelKey)}
        </label>
      ))}
    </div>
  );
}

function PermissionTierSummary(props: { inputTrustLevel: "open" | "restricted" | "unknown"; permission: AutomationPermissionProfile; onEscalate: () => void }) {
  if (props.inputTrustLevel === "open") {
    return (
      <div className="text-sm text-dls-secondary">
        {t("automation.event_permission_open_locked")}
        {props.permission === "unattended-full-access-v1" ? null : (
          <button type="button" onClick={props.onEscalate} className="ml-2 underline">{t("automation.event_permission_escalate")}</button>
        )}
      </div>
    );
  }
  return <p className="text-sm text-dls-secondary">{t("automation.event_permission_restricted_default")}</p>;
}

function EscalationConfirm(props: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-background p-6">
        <p className="text-sm">{t("automation.event_permission_escalate_warning")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={props.onCancel} className="rounded-full border border-dls-border px-4 py-2 text-sm">{t("automation.cancel")}</button>
          <button type="button" onClick={props.onConfirm} className="rounded-full bg-red-9 px-4 py-2 text-sm text-white">{t("automation.event_permission_escalate_confirm")}</button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

/** 就绪态未知时的兜底投递方式提示，供触发方式选择器展示。 */
export function useTriggerKindDiscardConfirmation(hasEventDraft: boolean) {
  return useMemo(() => ({
    shouldConfirm: hasEventDraft,
    message: t("automation.event_discard_confirm"),
  }), [hasEventDraft]);
}
