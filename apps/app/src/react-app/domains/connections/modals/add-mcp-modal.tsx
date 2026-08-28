/** @jsxImportSource react */
import { useEffect, useReducer } from "react";
import { ExternalLink, Loader2, Plus, Sparkles } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import type { McpDirectoryInfo } from "@/app/constants";
import { npmPackageReadme } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { formatCommand, lexCommand } from "../mcp-command-lexer";
import { parseMcpServersJson } from "../mcp-config-import";
import type { EnvHint } from "../mcp-env-hints";
import { extractEnvKeysFromReadme, packageNameFromCommand, rankEnvHints } from "../mcp-env-hints";
import type { KeyValueRow } from "../mcp-kv-entries";
import { firstInvalidKey, keyValueRowsToRecord } from "../mcp-kv-entries";
import { McpKeyValueTable } from "./mcp-key-value-table";

/**
 * 编辑既有 MCP 时用于回填表单的初值。
 * @param serverName 配置里的 server 名，提交时据此原地覆盖
 */
export type AddMcpInitialValue = {
  serverName: string;
  type: "remote" | "local";
  url?: string;
  command?: string[];
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
  timeout?: number;
};

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  /** 返回 Promise 时弹窗会等它完成再关闭，期间保持提交中状态。 */
  onAdd: (entry: McpDirectoryInfo) => void | Promise<void>;
  busy: boolean;
  isRemoteWorkspace: boolean;
  /** 有值时进入编辑模式：回填现有配置，且 server 名不可改。 */
  initial?: AddMcpInitialValue;
};

function toRows(source: Record<string, string> | undefined) {
  return Object.entries(source ?? {}).map(([key, value]) => ({ key, value }));
}

type AddMcpState = {
  mode: "form" | "json";
  name: string;
  serverType: "remote" | "local";
  url: string;
  oauthExpanded: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  command: string;
  cwd: string;
  timeout: string;
  advancedExpanded: boolean;
  environment: KeyValueRow[];
  headers: KeyValueRow[];
  jsonText: string;
  jsonNotice: string | null;
  placeholderKeys: string[];
  hints: EnvHint[];
  hintsPackage: string;
  hintsHomepage: string;
  error: string | null;
  submitting: boolean;
};

const initialAddMcpState: AddMcpState = {
  mode: "form",
  name: "",
  serverType: "remote",
  url: "",
  oauthExpanded: false,
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScope: "",
  command: "",
  cwd: "",
  timeout: "",
  advancedExpanded: false,
  environment: [],
  headers: [],
  jsonText: "",
  jsonNotice: null,
  placeholderKeys: [],
  hints: [],
  hintsPackage: "",
  hintsHomepage: "",
  error: null,
  submitting: false,
};

function addMcpReducer(state: AddMcpState, patch: Partial<AddMcpState> | "reset") {
  if (patch === "reset") return initialAddMcpState;
  return { ...state, ...patch };
}

export function AddMcpModal(props: AddMcpModalProps) {
  const [state, dispatch] = useReducer(addMcpReducer, initialAddMcpState);

  // TIPS: 建议只是加速器——停止输入后才查，查失败静默清空，绝不阻塞添加流程。
  useEffect(() => {
    if (!props.open || state.serverType !== "local" || state.mode !== "form") return;
    if (!isDesktopRuntime()) return;

    const parsed = lexCommand(state.command);
    const packageName = parsed.error ? "" : packageNameFromCommand(parsed.argv);
    if (!packageName || packageName === state.hintsPackage) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await npmPackageReadme({ packageName });
          if (cancelled) return;
          const keys = extractEnvKeysFromReadme(result.readme);
          dispatch({
            hints: rankEnvHints(keys, packageName),
            hintsPackage: packageName,
            hintsHomepage: result.homepage,
          });
        } catch {
          if (!cancelled) dispatch({ hints: [], hintsPackage: packageName, hintsHomepage: "" });
        }
      })();
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.open, state.command, state.serverType, state.mode, state.hintsPackage]);

  // TIPS: 编辑模式在弹窗打开时回填一次；serverName 不进表单，提交时单独带上，
  // 保证 connectMcp 算出的 slug 与既有条目一致，从而是原地覆盖而不是新建一条。
  useEffect(() => {
    if (!props.open || !props.initial) return;
    const initial = props.initial;
    dispatch({
      mode: "form",
      name: initial.serverName,
      serverType: initial.type,
      url: initial.url ?? "",
      command: initial.command?.length ? formatCommand(initial.command) : "",
      environment: toRows(initial.environment),
      headers: toRows(initial.headers),
      cwd: initial.cwd ?? "",
      timeout: initial.timeout ? String(initial.timeout) : "",
      advancedExpanded: Boolean(initial.cwd || initial.timeout),
    });
  }, [props.open, props.initial]);

  const reset = () => {
    dispatch("reset");
  };

  const handleClose = () => {
    if (state.submitting) return;
    reset();
    props.onClose();
  };

  const handleImportJson = () => {
    const result = parseMcpServersJson(state.jsonText);
    if (!result.ok) {
      const message = result.error === "invalid_json"
        ? t("mcp.json_invalid")
        : result.error === "no_server"
          ? t("mcp.json_no_server")
          : t("mcp.json_unsupported_shape");
      dispatch({ error: message });
      return;
    }

    const config = result.config;
    const isRemote = config.type === "remote";
    // 远程工作区不支持本地命令，导入的本地条目在此处直接拦下，避免落到不可用状态。
    if (!isRemote && props.isRemoteWorkspace) {
      dispatch({ error: t("mcp.remote_workspace_url_hint") });
      return;
    }

    dispatch({
      mode: "form",
      name: config.name,
      serverType: config.type,
      url: config.url,
      command: config.command,
      cwd: config.cwd,
      timeout: config.timeout,
      // TIPS: 导入的片段带了 cwd / timeout 就展开高级区——否则用户看不到也改不了，等于被静默吞掉。
      advancedExpanded: Boolean(config.cwd || config.timeout),
      environment: config.environment,
      headers: config.headers,
      placeholderKeys: config.placeholderKeys,
      error: null,
      jsonNotice: config.ignoredCount > 0
        ? t("mcp.json_ignored_servers").replace("{count}", String(config.ignoredCount))
        : null,
    });
  };

  const handleSubmit = async () => {
    if (state.submitting) return;
    dispatch({ error: null });

    const trimmedName = state.name.trim();
    if (!trimmedName) {
      dispatch({ error: t("mcp.name_required") });
      return;
    }

    if (state.serverType === "remote") {
      const invalidHeader = firstInvalidKey(state.headers, "header");
      if (invalidHeader) {
        dispatch({ error: t("mcp.header_key_invalid").replace("{key}", invalidHeader) });
        return;
      }
    } else {
      const invalidEnvKey = firstInvalidKey(state.environment, "env");
      if (invalidEnvKey) {
        dispatch({ error: t("mcp.env_key_invalid").replace("{key}", invalidEnvKey) });
        return;
      }
    }

    dispatch({ submitting: true });

    if (state.serverType === "remote") {
      const trimmedUrl = state.url.trim();
      const oauthClientId = state.oauthClientId.trim();
      const oauthClientSecret = state.oauthClientSecret.trim();
      const oauthScope = state.oauthScope.trim();
      if (!trimmedUrl) {
        dispatch({ error: t("mcp.url_or_command_required"), submitting: false });
        return;
      }
      if (!oauthClientId && (oauthClientSecret || oauthScope)) {
        dispatch({ error: t("mcp.oauth_client_id_required"), submitting: false });
        return;
      }

      const oauthConfig = oauthClientId
        ? {
            clientId: oauthClientId,
            ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
            ...(oauthScope ? { scope: oauthScope } : {}),
          }
        : undefined;

      const headers = keyValueRowsToRecord(state.headers);

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            ...(props.initial ? { serverName: props.initial.serverName } : {}),
            description: "",
            type: "remote",
            url: trimmedUrl,
            oauth: Boolean(oauthConfig),
            ...(oauthConfig ? { oauthConfig } : {}),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          }),
        );
      } finally {
        dispatch({ submitting: false });
      }
    } else {
      const parsed = lexCommand(state.command);
      if (parsed.error === "unterminated_quote") {
        dispatch({ error: t("mcp.command_unterminated_quote"), submitting: false });
        return;
      }
      if (parsed.argv.length === 0) {
        dispatch({ error: t("mcp.url_or_command_required"), submitting: false });
        return;
      }

      const environment = keyValueRowsToRecord(state.environment);
      const cwd = state.cwd.trim();

      const timeoutText = state.timeout.trim();
      const timeout = timeoutText ? Number(timeoutText) : undefined;
      if (timeoutText && (!Number.isFinite(timeout) || (timeout ?? 0) <= 0)) {
        dispatch({ error: t("mcp.timeout_invalid"), submitting: false });
        return;
      }

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            ...(props.initial ? { serverName: props.initial.serverName } : {}),
            description: "",
            type: "local",
            command: parsed.argv,
            oauth: false,
            ...(Object.keys(environment).length > 0 ? { environment } : {}),
            ...(cwd ? { cwd } : {}),
            ...(timeout ? { timeout } : {}),
          }),
        );
      } finally {
        dispatch({ submitting: false });
      }
    }

    handleClose();
  };

  const adoptHint = (key: string) => {
    if (state.environment.some((row) => row.key.trim() === key)) return;
    dispatch({ environment: [...state.environment, { key, value: "" }] });
  };

  const unusedHints = state.hints.filter(
    (hint) => !state.environment.some((row) => row.key.trim() === hint.key),
  );

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.initial ? t("mcp.edit_modal_title") : t("mcp.add_modal_title")}
          </DialogTitle>
          <DialogDescription>
            {props.initial ? t("mcp.edit_modal_subtitle") : t("mcp.add_modal_subtitle")}
          </DialogDescription>
        </DialogHeader>

        {/* TIPS: 粘贴 JSON 是主路径而非补充——几乎所有 MCP 的 README 给的就是这段配置，
            让用户粘贴远比逐字段誊抄准确，也省去猜环境变量 key 名这件根本猜不出来的事。 */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              state.mode === "form"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
            }`}
            onClick={() => dispatch({ mode: "form", error: null })}
          >
            {t("mcp.mode_form")}
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              state.mode === "json"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
            }`}
            onClick={() => dispatch({ mode: "json", error: null })}
          >
            {t("mcp.mode_json")}
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {state.mode === "json" ? (
            <div className="space-y-3">
              <div className="text-xs text-dls-secondary">{t("mcp.json_hint")}</div>
              <textarea
                aria-label={t("mcp.mode_json")}
                value={state.jsonText}
                onChange={(event) => dispatch({ jsonText: event.currentTarget.value })}
                spellCheck={false}
                rows={12}
                placeholder={'{\n  "mcpServers": {\n    "postgres": {\n      "command": "npx",\n      "args": ["-y", "@x/postgres-mcp"],\n      "env": { "DATABASE_URI": "postgresql://localhost/db" }\n    }\n  }\n}'}
                className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs leading-relaxed text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              />
              <Button variant="outline" size="sm" onClick={handleImportJson}>
                {t("mcp.json_parse")}
              </Button>
            </div>
          ) : (
            <>
              <TextInput
                label={t("mcp.server_name")}
                placeholder={t("mcp.server_name_placeholder")}
                value={state.name}
                disabled={Boolean(props.initial)}
                hint={props.initial ? t("mcp.server_name_locked_hint") : undefined}
                onChange={(event) => dispatch({ name: event.currentTarget.value })}
              />

              {state.jsonNotice ? (
                <div className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-[11px] text-amber-11">
                  {state.jsonNotice}
                </div>
              ) : null}

              {/* TIPS: 占位符提示对本地与远程都要出现——请求头里的 `<YOUR_TOKEN>` 同样被清空过。 */}
              {state.placeholderKeys.length > 0 ? (
                <div className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-[11px] text-amber-11">
                  {t("mcp.env_placeholder_cleared").replace("{keys}", state.placeholderKeys.join(", "))}
                </div>
              ) : null}

              <div>
                <div className="mb-1 text-xs font-medium text-dls-secondary">
                  {t("mcp.server_type")}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      state.serverType === "remote"
                        ? "bg-dls-active text-dls-text"
                        : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                    }`}
                    onClick={() => dispatch({ serverType: "remote" })}
                  >
                    {t("mcp.type_remote")}
                  </button>
                  <button
                    type="button"
                    disabled={props.isRemoteWorkspace}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      state.serverType === "local"
                        ? "bg-dls-active text-dls-text"
                        : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                    } ${props.isRemoteWorkspace ? "opacity-50 cursor-not-allowed" : ""}`}
                    onClick={() => {
                      if (props.isRemoteWorkspace) return;
                      dispatch({ serverType: "local" });
                    }}
                  >
                    {t("mcp.type_local_cmd")}
                  </button>
                </div>
                {props.isRemoteWorkspace ? (
                  <div className="mt-2 text-[11px] text-dls-secondary">
                    {t("mcp.remote_workspace_url_hint")}
                  </div>
                ) : null}
              </div>

              {state.serverType === "remote" ? (
                <div className="space-y-3">
                  <TextInput
                    label={t("mcp.server_url")}
                    placeholder={t("mcp.server_url_placeholder")}
                    value={state.url}
                    onChange={(event) => dispatch({ url: event.currentTarget.value })}
                  />

                  <McpKeyValueTable
                    kind="header"
                    rows={state.headers}
                    onChange={(headers) => dispatch({ headers })}
                  />

                  <div className="text-[11px] text-dls-secondary">
                    {t("mcp.oauth_autodetect_hint")}
                  </div>
                  <div className="rounded-xl border border-dls-border bg-dls-hover/30">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-dls-text"
                      onClick={() => dispatch({ oauthExpanded: !state.oauthExpanded })}
                    >
                      <span>{t("mcp.oauth_advanced_title")}</span>
                      <span className="text-dls-secondary">{state.oauthExpanded ? "-" : "+"}</span>
                    </button>
                    {state.oauthExpanded ? (
                      <div className="space-y-3 border-t border-dls-border px-3 py-3">
                        <div className="text-[11px] leading-relaxed text-dls-secondary">
                          {t("mcp.oauth_advanced_hint")}
                        </div>
                        <TextInput
                          label={t("mcp.oauth_client_id")}
                          placeholder={t("mcp.oauth_client_id_placeholder")}
                          value={state.oauthClientId}
                          onChange={(event) => dispatch({ oauthClientId: event.currentTarget.value })}
                        />
                        <TextInput
                          label={t("mcp.oauth_client_secret")}
                          placeholder={t("mcp.oauth_client_secret_placeholder")}
                          type="password"
                          value={state.oauthClientSecret}
                          onChange={(event) => dispatch({ oauthClientSecret: event.currentTarget.value })}
                        />
                        <TextInput
                          label={t("mcp.oauth_scope")}
                          placeholder={t("mcp.oauth_scope_placeholder")}
                          value={state.oauthScope}
                          onChange={(event) => dispatch({ oauthScope: event.currentTarget.value })}
                        />
                        <div className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-[11px] leading-relaxed text-amber-11">
                          {t("mcp.oauth_secret_warning")}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {state.serverType === "local" ? (
                <div className="space-y-3">
                  <TextInput
                    label={t("mcp.server_command")}
                    placeholder={t("mcp.server_command_placeholder")}
                    hint={t("mcp.server_command_hint")}
                    value={state.command}
                    onChange={(event) => dispatch({ command: event.currentTarget.value })}
                  />

                  <McpKeyValueTable
                    kind="env"
                    rows={state.environment}
                    onChange={(environment) => dispatch({ environment })}
                    footer={
                      <div className="space-y-2">
                        {unusedHints.length > 0 ? (
                          <div className="rounded-lg border border-dls-border bg-dls-hover/30 px-3 py-2">
                            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-dls-secondary">
                              <Sparkles className="size-3" />
                              {t("mcp.env_hints_title").replace("{package}", state.hintsPackage)}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {unusedHints.map((hint) => (
                                <button
                                  key={hint.key}
                                  type="button"
                                  onClick={() => adoptHint(hint.key)}
                                  className="rounded-md border border-dls-border bg-dls-surface px-2 py-1 font-mono text-[11px] text-dls-text transition-colors hover:border-dls-border-hover hover:bg-dls-hover"
                                >
                                  + {hint.key}
                                </button>
                              ))}
                            </div>
                            <div className="mt-1.5 text-[10px] text-dls-secondary">
                              {t("mcp.env_hints_source_readme")}
                            </div>
                          </div>
                        ) : null}

                        {state.hintsHomepage ? (
                          <a
                            href={state.hintsHomepage}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-dls-secondary hover:text-dls-text"
                          >
                            <ExternalLink className="size-3" />
                            {t("mcp.env_hints_open_docs").replace("{package}", state.hintsPackage)}
                          </a>
                        ) : null}

                        <div className="text-[10px] leading-relaxed text-dls-secondary">
                          {t("mcp.env_plaintext_warning")}
                        </div>
                      </div>
                    }
                  />

                  {/* TIPS: 工作目录与超时都只在少数场景才需要改，默认值（工作区根目录 / 5000ms）
                      覆盖绝大多数 MCP。收进折叠区，避免每个用户都要判断一次这两个字段填什么。 */}
                  <div className="rounded-xl border border-dls-border bg-dls-hover/30">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-dls-text"
                      onClick={() => dispatch({ advancedExpanded: !state.advancedExpanded })}
                    >
                      <span>{t("mcp.local_advanced_title")}</span>
                      <span className="text-dls-secondary">{state.advancedExpanded ? "-" : "+"}</span>
                    </button>
                    {state.advancedExpanded ? (
                      <div className="space-y-3 border-t border-dls-border px-3 py-3">
                        <TextInput
                          label={t("mcp.server_cwd")}
                          placeholder={t("mcp.server_cwd_placeholder")}
                          hint={t("mcp.server_cwd_hint")}
                          value={state.cwd}
                          onChange={(event) => dispatch({ cwd: event.currentTarget.value })}
                        />
                        <TextInput
                          label={t("mcp.server_timeout")}
                          placeholder={t("mcp.server_timeout_placeholder")}
                          hint={t("mcp.server_timeout_hint")}
                          inputMode="numeric"
                          value={state.timeout}
                          onChange={(event) => dispatch({ timeout: event.currentTarget.value })}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}

          {state.error ? (
            <div className="rounded-lg bg-red-2 border border-red-6 px-3 py-2 text-xs text-red-11">
              {state.error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          <DialogClose
            render={<Button variant="outline" disabled={state.submitting} />}
            disabled={state.submitting}
          >
            {t("mcp.auth.cancel")}
          </DialogClose>
          <Button
            onClick={() => void handleSubmit()}
            disabled={props.busy || state.submitting || state.mode === "json"}
          >
            {props.busy || state.submitting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            {props.initial ? t("mcp.save_server_button") : t("mcp.add_server_button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
