import * as React from "react";
import { CalendarPlus, MessageSquareText, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { JuggleWorkServerClient, NativeActionProposalView } from "@/app/lib/jugglework-server";
import { t } from "@/i18n";
import { executeConfirmedProposal } from "./native-execute";
import { liveNativeActionScope } from "./native-actions-responder";
import { useNativeActionProposals } from "./native-action-proposals-provider";

type Preview = Record<string, unknown>;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const chats = (value: unknown) => Array.isArray(value) ? value as Array<{ kind: string; name: string }> : [];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2"><span className="w-16 shrink-0 text-dls-secondary">{label}</span><span className="min-w-0 whitespace-pre-wrap break-words">{children}</span></div>;
}

function chatLabel(target: { kind: string; name: string }) {
  return t(target.kind === "group" ? "native_actions.chat_group" : "native_actions.chat_direct", { name: target.name });
}

function PreviewBody({ action, preview }: { action: NativeActionProposalView["action"]; preview: Preview }) {
  if (action === "im.send") {
    const to = preview.to as { kind: string; name: string };
    return <><Row label={t("native_actions.to")}>{chatLabel(to)}</Row><Row label={t("native_actions.text")}>{String(preview.text)}</Row></>;
  }
  const when = preview.allDay
    ? `${preview.startDate}${preview.endDate !== preview.startDate ? ` – ${preview.endDate}` : ""} · ${t("native_actions.all_day")}`
    : preview.immediate ? t("native_actions.start_now")
    : action === "meeting.create" ? `${String(preview.start).replace("T", " ")} · ${t("native_actions.minutes", { count: String(preview.durationMinutes) })} · ${preview.timeZone}`
    : `${String(preview.start).replace("T", " ")} – ${String(preview.end).replace("T", " ")} · ${preview.timeZone}`;
  const people = list(action === "calendar.create" ? preview.attendees : preview.invitees);
  return (
    <>
      <Row label={t("native_actions.title")}>{String(preview.title)}</Row>
      {action === "calendar.create" ? <Row label={t("native_actions.calendar")}>{String(preview.calendar)}</Row> : null}
      <Row label={t("native_actions.time")}>{when}</Row>
      <Row label={t(action === "calendar.create" ? "native_actions.attendees" : "native_actions.invitees")}>{people.length ? people.join("、") : t("native_actions.none")}</Row>
      {preview.description ? <Row label={t("native_actions.description")}>{String(preview.description)}</Row> : null}
      <Row label={t("native_actions.effects")}>
        {action === "calendar.create"
          ? t(preview.effect === "attendees_see_event" ? "native_actions.effect_attendees" : "native_actions.effect_personal")
          : <>
              {preview.notifyInvitees ? t("native_actions.effect_notify", { count: String(preview.notifyCount) }) : t("native_actions.effect_no_notify")}
              {chats(preview.shareTo).length ? <><br />{t("native_actions.effect_share", { targets: chats(preview.shareTo).map(chatLabel).join("、") })}</> : null}
              <br />{t("native_actions.effect_no_join")}
            </>}
      </Row>
    </>
  );
}

const STEP_LABEL: Record<string, string> = {
  "calendar.create": "native_actions.step_calendar", "meeting.create": "native_actions.step_meeting", "meeting.notify": "native_actions.step_notify",
  "meeting.share": "native_actions.step_share", "im.send": "native_actions.step_im",
};

function Receipt({ steps }: { steps: NativeActionProposalView["steps"] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {steps.map((entry, index) => {
        const to = typeof entry.result?.to === "string" ? ` · ${entry.result.to}` : "";
        const code = typeof entry.result?.code === "string" ? ` · ${t("native_actions.meeting_code", { code: entry.result.code })}` : "";
        return (
          <li key={index} className={entry.status === "succeeded" ? "" : entry.status === "skipped" ? "text-dls-secondary" : "text-red-11"}>
            {t(`native_actions.status_${entry.status}`)} · {t(STEP_LABEL[entry.name] ?? entry.name)}{to}{code}{entry.error ? ` — ${entry.error}` : ""}
          </li>
        );
      })}
    </ul>
  );
}

const ICON = { "calendar.create": CalendarPlus, "meeting.create": Video, "im.send": MessageSquareText } as const;

/** Confirmation card for one prepared native write. The click here is the only path that performs it. */
export function NativeActionCard({ client, workspaceId, sessionId, proposal }: {
  client: JuggleWorkServerClient | null; workspaceId: string; sessionId: string; proposal: NativeActionProposalView;
}) {
  const { replace } = useNativeActionProposals();
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const clicked = React.useRef(false);
  const expired = proposal.state === "pending" && Date.parse(proposal.expiresAt) <= Date.now();
  const state = expired ? "expired" : proposal.state;
  const Icon = ICON[proposal.action];

  const confirm = async () => {
    // TIPS: 同步标记防止双击；服务端 claim 再保证只执行一次。
    if (!client || clicked.current) return;
    clicked.current = true;
    setWorking(true);
    setError(null);
    try {
      const claimed = await client.nativeActionClaim(workspaceId, sessionId, proposal.id);
      replace(claimed.proposal);
      // TIPS: 执行依赖含 IM SDK，按需加载，避免消息列表一渲染就初始化聊天 SDK。
      const { defaultExecuteDeps } = await import("./native-execute-deps");
      const steps = await executeConfirmedProposal(proposal.action, claimed.scope, claimed.execution, defaultExecuteDeps(liveNativeActionScope));
      replace(await client.nativeActionComplete(workspaceId, sessionId, proposal.id, steps));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  const cancel = async () => {
    if (!client || clicked.current) return;
    clicked.current = true;
    try { replace(await client.nativeActionCancel(workspaceId, sessionId, proposal.id)); }
    catch (cause) { clicked.current = false; setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return (
    <Card variant="outline" size="sm" className="gap-2 rounded-xl px-3 py-2 text-xs" data-native-action={proposal.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium"><Icon className="size-4 shrink-0" />{t(`native_actions.kind_${proposal.action.replace(".", "_")}`)}</span>
        <span className="text-dls-secondary">{t(`native_actions.state_${state}`)}</span>
      </div>
      <div className="flex flex-col gap-1"><PreviewBody action={proposal.action} preview={proposal.preview} /></div>
      {proposal.steps.length ? <Receipt steps={proposal.steps} /> : null}
      {error ? <div className="text-red-11">{error}</div> : null}
      {state === "pending" ? (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-7" disabled={working} onClick={() => void cancel()}>{t("native_actions.cancel")}</Button>
          <Button size="sm" className="h-7" disabled={working || !client} onClick={() => void confirm()}>{t(working ? "native_actions.confirming" : `native_actions.confirm_${proposal.action.replace(".", "_")}`)}</Button>
        </div>
      ) : null}
    </Card>
  );
}

/** All proposals prepared during one user turn, shown under that turn's reply. */
export function NativeActionTurnCards({ client, workspaceId, sessionId, turnId }: {
  client: JuggleWorkServerClient | null; workspaceId: string; sessionId: string; turnId: string;
}) {
  const { items } = useNativeActionProposals();
  const own = items.filter((item) => item.turnId === turnId);
  if (!own.length) return null;
  return <div className="flex flex-col gap-1.5 py-2" data-native-action-turn={turnId}>{own.map((item) => <NativeActionCard key={item.id} client={client} workspaceId={workspaceId} sessionId={sessionId} proposal={item} />)}</div>;
}
