import type { WorkspaceConnectionState, WorkspaceConnectionFailureReason } from "../../../app/types";
import type { WorkspaceInfo } from "../../../app/lib/desktop";
import {
  createJuggleWorkServerClient,
  normalizeJuggleWorkServerUrl,
  parseJuggleWorkWorkspaceIdFromUrl,
  type JuggleWorkServerClient,
} from "../../../app/lib/jugglework-server";
import { redactTokenLikeText } from "../../../app/utils";

export type RemoteWorkspaceConnectionTarget = {
  kind: "jugglework";
  baseUrl: string;
  endpointLabel: string;
  token: string;
  workspaceId: string | null;
};

type TargetResult =
  | { ok: true; target: RemoteWorkspaceConnectionTarget }
  | { ok: false; state: WorkspaceConnectionState };

export type RemoteWorkspaceConnectionResult = {
  ok: boolean;
  state: WorkspaceConnectionState;
  target?: RemoteWorkspaceConnectionTarget;
};

type TestOptions = {
  now?: () => number;
  createClient?: (target: RemoteWorkspaceConnectionTarget) => Pick<
    JuggleWorkServerClient,
    "health" | "capabilities" | "status" | "listWorkspaces"
  > | Promise<Pick<JuggleWorkServerClient, "health" | "capabilities" | "status" | "listWorkspaces">>;
};

function trim(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function fail(
  message: string,
  checkedAt = Date.now(),
  reason: WorkspaceConnectionFailureReason = "unknown",
): RemoteWorkspaceConnectionResult {
  return {
    ok: false,
    state: {
      status: "error",
      message,
      checkedAt,
      reason,
    },
  };
}

function endpointLabel(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path && path !== "/" ? path : ""}`;
  } catch {
    return baseUrl;
  }
}

function stripJuggleWorkWorkspaceMount(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = prefix ? `/${prefix}` : "/";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Fall through to the already-normalized value below.
  }
  return baseUrl.replace(/\/+$/, "");
}

function isValidHttpEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

function describeUnknownError(error: unknown) {
  return redactRemoteDiagnosticText(error instanceof Error ? error.message : String(error || "Unknown error"));
}

function isServerErrorStatus(error: unknown, status: number | number[]) {
  const expected = Array.isArray(status) ? status : [status];
  const actual =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : NaN;
  return expected.includes(actual);
}

function rejectedTokenMessage(target: RemoteWorkspaceConnectionTarget) {
  return remoteSupportMessage(`Token was rejected by ${target.endpointLabel}. Edit connection and reconnect the worker.`);
}

// Redeploying a cloud worker provisions a new sandbox and therefore a new
// routing URL; the old host either stops resolving or the gateway answers
// 404 "The sandbox route is unavailable". Both mean "the saved URL points at
// a worker that no longer exists", which the UI presents as an update-
// connection prompt instead of a generic network error.
const UNREACHABLE_ERROR_HINTS = [
  "sandbox route is unavailable",
  "enotfound",
  "econnrefused",
  "econnreset",
  "eai_again",
  "failed to fetch",
  "fetch failed",
  "network error",
  "networkerror",
  "load failed",
];

function classifyUnreachableError(error: unknown): boolean {
  if (isServerErrorStatus(error, 404)) return true;
  const text = describeUnknownError(error).toLowerCase();
  return UNREACHABLE_ERROR_HINTS.some((hint) => text.includes(hint));
}

function workerUnreachableMessage(target: RemoteWorkspaceConnectionTarget, cause: string) {
  return `Cannot reach ${target.endpointLabel} (${cause}). The cloud workspace may have been redeployed and its URL changed. Copy the new connection details from the JuggleWork Cloud console and update this connection.`;
}

function remoteSupportMessage(message: string) {
  return `${message} Upgrade the JuggleWork host and try again. If this continues, contact team@juggle.im.`;
}

export function redactRemoteDiagnosticText(value: string): string {
  return redactTokenLikeText(value);
}

export function getRemoteWorkspaceConnectionKey(workspace: WorkspaceInfo): string {
  return [
    workspace.id,
    workspace.workspaceType,
    workspace.remoteType ?? "",
    trim(workspace.baseUrl),
    trim(workspace.juggleworkHostUrl),
    trim(workspace.juggleworkWorkspaceId),
    trim(workspace.juggleworkToken),
    trim(workspace.juggleworkClientToken),
    trim(workspace.juggleworkHostToken),
  ].join("\u001f");
}

function displayWorkspaceName(workspace: unknown) {
  if (!workspace || typeof workspace !== "object") return "";
  const value = workspace as {
    displayName?: string | null;
    juggleworkWorkspaceName?: string | null;
    name?: string | null;
    id?: string | null;
  };
  return (
    trim(value.displayName) ||
    trim(value.juggleworkWorkspaceName) ||
    trim(value.name) ||
    trim(value.id)
  );
}

function defaultCreateClient(target: RemoteWorkspaceConnectionTarget) {
  return createJuggleWorkServerClient({
    baseUrl: target.baseUrl,
    token: target.token || undefined,
  });
}

export function resolveRemoteWorkspaceConnectionTarget(workspace: WorkspaceInfo): TargetResult {
  if (workspace.workspaceType !== "remote") {
    return {
      ok: false,
      state: {
        status: "error",
        message: "Only remote workers can be tested.",
        checkedAt: Date.now(),
      },
    };
  }

  if (workspace.remoteType && workspace.remoteType !== "jugglework") {
    return {
      ok: false,
      state: {
        status: "error",
        message: "Connection diagnostics are only available for JuggleWork remote workers.",
        checkedAt: Date.now(),
      },
    };
  }

  const rawHostUrl = trim(workspace.juggleworkHostUrl) || trim(workspace.baseUrl);
  if (!rawHostUrl) {
    return {
      ok: false,
      state: {
        status: "error",
        message: remoteSupportMessage("Remote worker URL is missing. Edit connection and add a server URL."),
        checkedAt: Date.now(),
      },
    };
  }

  const normalizedHostUrl = normalizeJuggleWorkServerUrl(rawHostUrl);
  if (!normalizedHostUrl || !isValidHttpEndpoint(normalizedHostUrl)) {
    return {
      ok: false,
      state: {
        status: "error",
        message: remoteSupportMessage("Remote worker URL is invalid. Edit connection and use an http:// or https:// URL."),
        checkedAt: Date.now(),
      },
    };
  }

  const workspaceId =
    trim(workspace.juggleworkWorkspaceId) ||
    parseJuggleWorkWorkspaceIdFromUrl(normalizedHostUrl) ||
    parseJuggleWorkWorkspaceIdFromUrl(trim(workspace.baseUrl)) ||
    null;
  const hostBaseUrl = stripJuggleWorkWorkspaceMount(normalizedHostUrl);
  const token =
    trim(workspace.juggleworkToken) ||
    trim(workspace.juggleworkClientToken) ||
    trim(workspace.juggleworkHostToken);

  return {
    ok: true,
    target: {
      kind: "jugglework",
      baseUrl: hostBaseUrl,
      endpointLabel: endpointLabel(hostBaseUrl),
      token,
      workspaceId,
    },
  };
}

export async function testRemoteWorkspaceConnection(
  workspace: WorkspaceInfo,
  options: TestOptions = {},
): Promise<RemoteWorkspaceConnectionResult> {
  const checkedAt = options.now?.() ?? Date.now();
  const targetResult = resolveRemoteWorkspaceConnectionTarget(workspace);
  if (!targetResult.ok) {
    return {
      ok: false,
      state: {
        ...targetResult.state,
        checkedAt,
      },
    };
  }

  const { target } = targetResult;
  const client = await (options.createClient?.(target) ?? defaultCreateClient(target));

  try {
    const health = await client.health();
    if (!health?.ok) {
      return fail(
        remoteSupportMessage(`Cannot reach ${target.endpointLabel}. Health check returned an unhealthy response.`),
        checkedAt,
      );
    }
  } catch (error) {
    if (classifyUnreachableError(error)) {
      return fail(workerUnreachableMessage(target, describeUnknownError(error)), checkedAt, "worker_unreachable");
    }
    // The edge answers 401 when the endpoint exists but the presented token is
    // wrong (the health request carries the same bearer as every other call).
    // That is a stale-token problem, not a redeployed worker.
    if (isServerErrorStatus(error, [401, 403])) {
      return fail(rejectedTokenMessage(target), checkedAt, "token_rejected");
    }
    return fail(
      remoteSupportMessage(`Cannot reach ${target.endpointLabel}. Health check failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }

  if (!target.token) {
    return fail(
      remoteSupportMessage(`Token is missing for ${target.endpointLabel}. Edit connection and paste a valid JuggleWork token.`),
      checkedAt,
    );
  }

  try {
    await client.capabilities();
  } catch (error) {
    if (isServerErrorStatus(error, [401, 403])) {
      return fail(rejectedTokenMessage(target), checkedAt, "token_rejected");
    }
    return fail(
      remoteSupportMessage(`Connected to ${target.endpointLabel}, but capabilities failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }

  if (target.workspaceId) {
    try {
      const list = await client.listWorkspaces();
      const workspace = list.items.find((item) => item.id === target.workspaceId) ?? null;
      if (!workspace) {
        return fail(
          remoteSupportMessage(`Workspace ${target.workspaceId} was not found on ${target.endpointLabel}. Reconnect the worker.`),
          checkedAt,
          "workspace_missing",
        );
      }
      const name = displayWorkspaceName(workspace) || target.workspaceId;
      return {
        ok: true,
        target,
        state: {
          status: "connected",
          message: `Connected to ${name}.`,
          checkedAt,
        },
      };
    } catch (error) {
      if (isServerErrorStatus(error, 403)) {
        return fail(
          remoteSupportMessage(`Workspace ${target.workspaceId} is not authorized on ${target.endpointLabel}. Check the token or server access rules.`),
          checkedAt,
        );
      }
      return fail(
        remoteSupportMessage(`Connected to ${target.endpointLabel}, but workspace list failed: ${describeUnknownError(error)}`),
        checkedAt,
      );
    }
  }

  try {
    const list = await client.listWorkspaces();
    const active =
      list.items.find((item) => item.id === list.activeId) ??
      list.items[0] ??
      null;
    const name = displayWorkspaceName(active) || target.endpointLabel;
    return {
      ok: true,
      target,
      state: {
        status: "connected",
        message: `Connected to ${name}.`,
        checkedAt,
      },
    };
  } catch (error) {
    if (isServerErrorStatus(error, [401, 403])) {
      return fail(rejectedTokenMessage(target), checkedAt);
    }
    return fail(
      remoteSupportMessage(`Connected to ${target.endpointLabel}, but workspace list failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }
}

export async function diagnoseRemoteWorkspaceTaskLoadFailure(
  workspace: WorkspaceInfo,
  taskLoadError: string,
  options: TestOptions = {},
): Promise<WorkspaceConnectionState> {
  const checkedAt = options.now?.() ?? Date.now();
  const fallback = redactRemoteDiagnosticText(trim(taskLoadError) || "Remote worker connection failed.");

  try {
    const diagnostic = await testRemoteWorkspaceConnection(workspace, options);
    if (diagnostic.ok) {
      return {
        status: "error",
        message: `Worker is reachable, but tasks failed to load: ${fallback}`,
        checkedAt: diagnostic.state.checkedAt ?? checkedAt,
      };
    }

    return {
      status: "error",
      message: diagnostic.state.message?.trim() || fallback,
      checkedAt: diagnostic.state.checkedAt ?? checkedAt,
      reason: diagnostic.state.reason ?? null,
    };
  } catch (error) {
    return {
      status: "error",
      message: fallback || describeUnknownError(error),
      checkedAt,
    };
  }
}

/** True when the saved connection points at a worker endpoint that no longer
 * exists — typically because the cloud worker was redeployed and its URL
 * changed. UI uses this to show an "update connection" prompt. */
export function isRemoteWorkerUnreachableState(state: WorkspaceConnectionState | null | undefined): boolean {
  return state?.status === "error" && state.reason === "worker_unreachable";
}
