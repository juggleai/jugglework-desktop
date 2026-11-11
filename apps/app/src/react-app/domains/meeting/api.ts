import { meetingDiagnostic, meetingDiagnosticStep } from "./diagnostics";
import { meetingApiUrl } from "./api-url";
import { readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";
import type {
  Meeting,
  MeetingCreate,
  MeetingJoin,
  MeetingReadiness,
} from "./types";
const messages: Record<string, string> = {
  meeting_not_configured:
    "会议服务尚未配置，请修改服务端 conf/config.yml 并重启服务。",
  meeting_changed: "会议状态已变化，请刷新后重试。",
  meeting_closed: "会议已结束或取消。",
  meeting_full: "会议人数已满。",
  meeting_waiting_for_host: "请在会议开始前 10 分钟内进入，并等待主持人开始。",
  meeting_already_joined: "此账号已在其他窗口或设备参会，请先退出。",
  internal: "会议服务暂时无法完成请求，请稍后重试。",
  internal_error: "会议服务暂时无法完成请求，请稍后重试。",
  meeting_cleanup_pending: "会议已结束，音视频服务正在清理，请稍后查看状态。",
  forbidden: "你没有此操作的权限。",
  not_found: "会议不存在，或你没有访问权限。",
};
export function meetingScope() {
  const s = readDenSettings();
  return `${s.baseUrl ?? ""}|${s.activeOrgId ?? ""}|${s.authToken ?? ""}`;
}
export async function meetingRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const config = readDenSettings();
  if (!config.authToken || !config.activeOrgId)
    throw new Error("请先登录并选择组织。");
  const scope = meetingScope();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.authToken}`);
  headers.set("x-jugglework-legacy-org-id", config.activeOrgId);
  if (init.body) headers.set("Content-Type", "application/json");
  const route = path.split("?")[0];
  const res = await meetingDiagnosticStep("http.request", { route, method: init.method || "GET" }, () => fetch(
    meetingApiUrl(resolveDenBaseUrls(config).apiBaseUrl, path),
    { ...init, headers, signal: init.signal ?? AbortSignal.timeout(12_000) },
  ));
  meetingDiagnostic("http.response", { route, status: res.status, serverDate: res.headers.get("Date") });
  if (scope !== meetingScope())
    throw new Error("组织或账号已切换，请重新打开会议。");
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code =
      typeof body.error === "string"
        ? body.error
        : (body.error?.code ?? body.code);
    throw new Error(
      messages[code] ||
        body.error?.message ||
        body.message ||
        `会议请求失败（${res.status}）`,
    );
  }
  if (init.method && init.method !== "GET") window.dispatchEvent(new Event("meeting:changed"));
  return body as T;
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});
export const meetingAPI = {
  settings: () => meetingRequest<MeetingReadiness>("/settings"),
  list: (from: Date, to: Date) =>
    meetingRequest<{ meetings: Meeting[] }>(
      `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    ),
  get: (id: string) =>
    meetingRequest<{ meeting: Meeting }>(`/${encodeURIComponent(id)}`),
  create: (input: MeetingCreate, key: string) =>
    meetingRequest<{ meeting: Meeting }>("", {
      ...post(input),
      headers: { "Idempotency-Key": key },
    }),
  join: (id: string, sessionId = "") =>
    meetingRequest<MeetingJoin>(
      `/${encodeURIComponent(id)}/join`,
      post({ sessionId }),
    ),
  action: async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    try {
      return await meetingRequest<{ meeting: Meeting; cleanupPending?: boolean }>(
        `/${encodeURIComponent(id)}/actions`, post({ action, ...extra }),
      );
    } catch (error) {
      // Recover only a server-confirmed terminal state, never assume a failed
      // request ended a live meeting. Also supports servers predating HTTP 202.
      if (action === "end" || action === "cancel" || action === "leave") {
        const current = await meetingRequest<{ meeting: Meeting }>(
          `/${encodeURIComponent(id)}`,
        ).catch(() => null);
        if (current && ["ended", "cancelled", "expired"].includes(current.meeting.status)) {
          window.dispatchEvent(new Event("meeting:changed"));
          return { ...current, cleanupPending: true };
        }
      }
      throw error;
    }
  },
  invite: (id: string, userIds: string[]) =>
    meetingRequest<{ meeting: Meeting }>(
      `/${encodeURIComponent(id)}/invitations`,
      post({ userIds }),
    ),
  notify: (id: string) =>
    meetingRequest<void>(`/${encodeURIComponent(id)}/notify`, post({})),
};
