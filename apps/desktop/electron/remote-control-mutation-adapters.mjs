import path from "node:path";

import { z } from "zod";
import { desktopRemoteOperationResultSchema } from "../dist/runtime/desktop-remote-control.js";

import {
  REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION,
  REMOTE_CONTROL_REQUIRED_GATES,
  RemoteControlOperationExecutionError,
} from "./remote-control-operations.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";
import { SessionMutationError } from "./session-mutation-coordinator.mjs";

const identifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

const ISO_EPOCH = new Date(0).toISOString();

/** @typedef {{ id: string, name?: unknown, displayName?: unknown, path: string, workspaceType?: unknown }} LocalWorkspace */
/** @typedef {{ getJson(pathname: string): Promise<unknown>, postJson(pathname: string, body: unknown): Promise<unknown> }} ManagedRuntimeClient */
/** @typedef {{ beginRun(input: { workspaceId: string, sessionId: string }): { runId: string, generation: number }, recordPromptAccepted(input: { workspaceId: string, sessionId: string, runId: string }): void, resolveRun(input: { workspaceId: string, sessionId: string, expectedRunId: string }): { runId: string }, markAborting(input: { workspaceId: string, sessionId: string, runId: string }): void, markTerminal(input: { workspaceId: string, sessionId: string }): void, activeRuns(): unknown[] }} Coordinator */

/** @param {unknown} value */
function parseArguments(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length) {
    throw new TypeError("Remote mutation arguments are invalid.");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
      if (key === "prompt") {
        if (typeof value[key] !== "string" || value[key].trim().length < 1 || value[key].length > 200_000) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
        continue;
      }
      throw new TypeError("Remote mutation arguments are invalid.");
    }
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

/** @param {unknown} value */
function canonicalPath(value) {
  const input = typeof value === "string" ? value.trim() : "";
  return input ? path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "") || "/" : "";
}

/** @param {unknown} value @param {number} max */
function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function timestamp() {
  return new Date().toISOString();
}

/** @param {unknown} error @param {string} notFoundCode */
function mapClientError(error, notFoundCode) {
  if (error instanceof RemoteControlOperationExecutionError) throw error;
  if (error instanceof SessionMutationError) {
    throw new RemoteControlOperationExecutionError(
      error.code,
      error.currentRunId ? { currentRunId: error.currentRunId } : undefined,
    );
  }
  if (error instanceof ManagedRuntimeClientError && error.code === "http_error" && error.status === 404) {
    throw new RemoteControlOperationExecutionError(notFoundCode);
  }
  throw new RemoteControlOperationExecutionError("internal_error");
}

/**
 * @param {{ readWorkspaceState(): Promise<unknown> }} workspaceStore
 * @returns {Promise<LocalWorkspace[]>}
 */
async function localWorkspaces(workspaceStore) {
  const state = await workspaceStore.readWorkspaceState();
  const entries = state && typeof state === "object" && "workspaces" in state && Array.isArray(state.workspaces) ? state.workspaces : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || entry.workspaceType === "remote") return [];
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const workspacePath = canonicalPath(entry.path);
    return identifierSchema.safeParse(id).success && workspacePath ? [{ ...entry, id, path: workspacePath }] : [];
  });
}

/**
 * @param {{ readWorkspaceState(): Promise<unknown> }} workspaceStore
 * @param {ManagedRuntimeClient} client
 * @param {string} workspaceId
 */
async function authorizedWorkspace(workspaceStore, client, workspaceId) {
  // Try managed server first (authoritative), fall back to local store.
  try {
    const response = await client.getJson("/workspaces");
    if (response && typeof response === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (response).items)) {
      const found = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (response).items).find(
        (/** @type {Record<string, unknown>} */ entry) =>
          entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim() === workspaceId,
      );
      if (found) {
        const workspacePath = canonicalPath(found.path || found.directory);
        return {
          id: workspaceId,
          name: typeof found.name === "string" ? found.name : (typeof found.displayName === "string" ? found.displayName : ""),
          path: workspacePath || "/",
          workspaceType: typeof found.workspaceType === "string" ? found.workspaceType : "local",
        };
      }
    }
  } catch {
    // Fall through to local store.
  }
  const workspace = (await localWorkspaces(workspaceStore)).find((entry) => entry.id === workspaceId);
  if (!workspace) throw new RemoteControlOperationExecutionError("workspace_not_found");
  return workspace;
}

/**
 * @param {ManagedRuntimeClient} client
 * @param {string} workspaceId
 * @param {string} sessionId
 */
async function readSession(client, workspaceId, sessionId) {
  try {
    const response = await client.getJson(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`);
    if (!response || typeof response !== "object" || !("item" in response)) {
      throw new RemoteControlOperationExecutionError("session_not_found");
    }
    const item = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (response).item);
    return { directory: typeof item.directory === "string" ? item.directory : "", id: typeof item.id === "string" ? item.id : "" };
  } catch (error) {
    mapClientError(error, "session_not_found");
  }
}

/**
 * Builds concrete mutation registrations for session.prompt and session.abort.
 *
 * @param {{
 *   workspaceStore: { readWorkspaceState(): Promise<unknown> },
 *   managedRuntimeClient: ManagedRuntimeClient,
 *   coordinator: Coordinator,
 *   now?: () => number,
 * }} options
 */
export function createRemoteControlMutationRegistrations({ workspaceStore, managedRuntimeClient, coordinator, now = Date.now }) {
  if (!workspaceStore || typeof workspaceStore.readWorkspaceState !== "function" || !managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function" || typeof managedRuntimeClient.postJson !== "function" || !coordinator || typeof coordinator.beginRun !== "function") {
    throw new TypeError("Remote mutation adapter dependencies are invalid.");
  }

  const registration = (operation, validateArguments, execute) => ({
    operation,
    payloadVersions: [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION],
    requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES[operation]],
    validateArguments,
    execute,
  });

  return [
    registration("session.prompt", (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of ["workspaceId", "sessionId"]) {
        if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      if (typeof value.prompt !== "string" || value.prompt.trim().length < 1 || value.prompt.length > 200_000) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), prompt: value.prompt });
    }, async ({ arguments: args }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const session = await readSession(managedRuntimeClient, workspace.id, args.sessionId);
        if (canonicalPath(session.directory) !== workspace.path) {
          throw new RemoteControlOperationExecutionError("session_not_found");
        }
        const { runId, generation } = coordinator.beginRun({ workspaceId: workspace.id, sessionId: args.sessionId });
        await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/opencode/session/${encodeURIComponent(args.sessionId)}/prompt_async`,
          { parts: [{ type: "text", text: args.prompt }] },
        );
        coordinator.recordPromptAccepted({ workspaceId: workspace.id, sessionId: args.sessionId, runId });
        const result = { runId, generation };
        return desktopRemoteOperationResultSchema.parse({ operation: "session.prompt", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
    }),
    registration("session.abort", (value) => {
      parseArguments(value, ["workspaceId", "sessionId", "expectedRunId"]);
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), expectedRunId: String(value.expectedRunId) });
    }, async ({ arguments: args }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const { runId } = coordinator.resolveRun({ workspaceId: workspace.id, sessionId: args.sessionId, expectedRunId: args.expectedRunId });
        coordinator.markAborting({ workspaceId: workspace.id, sessionId: args.sessionId, runId });
        await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/opencode/session/${encodeURIComponent(args.sessionId)}/abort`,
          {},
        );
        coordinator.markTerminal({ workspaceId: workspace.id, sessionId: args.sessionId });
        const result = { runId, abortRequested: true };
        return desktopRemoteOperationResultSchema.parse({ operation: "session.abort", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
    }),
    registration("interaction.permission.reply", (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of ["workspaceId", "sessionId", "interactionId"]) {
        if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      if (value.response !== "allow_once" && value.response !== "reject") {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), interactionId: String(value.interactionId), response: /** @type {"allow_once" | "reject"} */ (value.response) });
    }, async ({ arguments: args }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        // Map desktop schema to OpenCode: "allow_once" → "once", "reject" → "reject"
        const opencodeReply = args.response === "allow_once" ? "once" : "reject";
        await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/opencode/permission/${encodeURIComponent(args.interactionId)}/reply`,
          { reply: opencodeReply },
        );
        const result = { interactionId: args.interactionId, status: "resolved" };
        return desktopRemoteOperationResultSchema.parse({ operation: "interaction.permission.reply", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "interaction_not_found");
      }
    }),
    registration("interaction.question.reply", (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of ["workspaceId", "sessionId", "interactionId"]) {
        if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      if (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 100) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const answer of value.answers) {
        if (!answer || typeof answer !== "object" || Array.isArray(answer) || Object.keys(answer).length !== 2 ||
          !identifierSchema.safeParse(answer.questionId).success ||
          !Array.isArray(answer.values) || answer.values.length < 1 || answer.values.length > 100 ||
          answer.values.some((/** @type {unknown} */ v) => typeof v !== "string" || v.length > 10_000)) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      return Object.freeze({
        workspaceId: String(value.workspaceId),
        sessionId: String(value.sessionId),
        interactionId: String(value.interactionId),
        answers: value.answers.map((/** @type {Record<string, unknown>} */ a) => ({ questionId: String(a.questionId), values: /** @type {string[]} */ (a.values) })),
      });
    }, async ({ arguments: args }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        // OpenCode question reply expects answers as string[][] (one per question)
        const opencodeAnswers = args.answers.map((a) => a.values);
        await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/opencode/question/${encodeURIComponent(args.interactionId)}/reply`,
          { answers: opencodeAnswers },
        );
        const result = { interactionId: args.interactionId, status: "resolved" };
        return desktopRemoteOperationResultSchema.parse({ operation: "interaction.question.reply", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "interaction_not_found");
      }
    }),
  ];
}
