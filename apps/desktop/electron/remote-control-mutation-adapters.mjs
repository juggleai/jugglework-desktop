import path from "node:path";

import { z } from "zod";
import { desktopRemoteOperationResultSchema } from "../dist/runtime/desktop-remote-control.js";

import {
  REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION,
  REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION,
  REMOTE_CONTROL_REQUIRED_GATES,
  RemoteControlOperationExecutionError,
} from "./remote-control-operations.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

const identifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

/** @param {unknown} value */
function isSessionCreateTitle(value) {
  if (typeof value !== "string" || value.trim() !== value || /\p{Cc}/u.test(value)) return false;
  let scalarCount = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff) || ++scalarCount > 120) return false;
  }
  return scalarCount >= 1;
}

const sessionCreateTitleSchema = z.string().refine(isSessionCreateTitle);

const ISO_EPOCH = new Date(0).toISOString();

/** @typedef {{ id: string, name?: unknown, displayName?: unknown, path: string, workspaceType?: unknown }} LocalWorkspace */
/** @typedef {{ getJson(pathname: string): Promise<unknown>, postJson(pathname: string, body: unknown): Promise<unknown> }} ManagedRuntimeClient */
/** @typedef {{ recordServerRun(input: unknown): boolean, activeRuns(): unknown[] }} Coordinator */

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
  if (error instanceof ManagedRuntimeClientError && ["session_busy", "run_mismatch", "pending_operation_not_found", "pending_operation_not_cancellable"].includes(error.serverCode)) {
    if (error.serverCode === "pending_operation_not_found") throw new RemoteControlOperationExecutionError("pending_operation_not_found");
    if (error.serverCode === "pending_operation_not_cancellable") throw new RemoteControlOperationExecutionError("pending_operation_not_cancellable");
    throw new RemoteControlOperationExecutionError(error.serverCode, { currentRunId: error.currentRunId });
  }
  if (error instanceof ManagedRuntimeClientError && error.code === "http_error" && error.status === 404) {
    throw new RemoteControlOperationExecutionError(notFoundCode);
  }
  throw new RemoteControlOperationExecutionError("internal_error");
}

const INTERACTION_ERROR_CODES = new Set(["already_resolved", "interaction_expired", "interaction_not_found"]);

/** @param {unknown} error */
function mapInteractionClientError(error) {
  if (error instanceof RemoteControlOperationExecutionError) throw error;
  if (error instanceof ManagedRuntimeClientError && error.code === "http_error") {
    if (INTERACTION_ERROR_CODES.has(error.serverCode)) {
      throw new RemoteControlOperationExecutionError(error.serverCode);
    }
    if (error.status === 400) throw new RemoteControlOperationExecutionError("invalid_request");
  }
  throw new RemoteControlOperationExecutionError("internal_error");
}

/** @param {unknown} response @param {string} interactionId @param {"interaction.permission.reply" | "interaction.question.reply"} operation */
function resolvedInteractionResult(response, interactionId, operation) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RemoteControlOperationExecutionError("internal_error");
  }
  const result = /** @type {Record<string, unknown>} */ (response);
  if (Object.keys(result).length !== 2 || result.interactionId !== interactionId || result.status !== "resolved") {
    throw new RemoteControlOperationExecutionError("internal_error");
  }
  return desktopRemoteOperationResultSchema.parse({ operation, payloadVersion: 1, result }).result;
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

/** @param {unknown} response @param {LocalWorkspace} workspace */
function createdSessionResult(response, workspace) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RemoteControlOperationExecutionError("internal_error");
  }
  const result = /** @type {Record<string, unknown>} */ (response);
  if (Object.keys(result).length !== 2 || !Object.hasOwn(result, "item") || !Object.hasOwn(result, "started") || result.started !== false ||
      !result.item || typeof result.item !== "object" || Array.isArray(result.item) || Object.keys(result.item).length > 32 ||
      Buffer.byteLength(JSON.stringify(response), "utf8") > 64 * 1024) {
    throw new RemoteControlOperationExecutionError("internal_error");
  }
  const item = /** @type {Record<string, unknown>} */ (result.item);
  const sessionId = identifierSchema.safeParse(item.id);
  const directory = canonicalPath(item.directory);
  if (!sessionId.success || !directory || directory !== workspace.path ||
      (Object.hasOwn(item, "workspaceId") && item.workspaceId !== workspace.id)) {
    throw new RemoteControlOperationExecutionError("internal_error");
  }
  const operationResult = { sessionId: sessionId.data };
  return desktopRemoteOperationResultSchema.parse({ operation: "session.create", payloadVersion: 1, result: operationResult }).result;
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
 *   interactions?: { resolveOwnership(input: { workspaceId: string, targetSessionId: string }): Promise<unknown> } | null,
 *   now?: () => number,
 * }} options
 */
export function createRemoteControlMutationRegistrations({ workspaceStore, managedRuntimeClient, coordinator, interactions = null, now = Date.now }) {
  if (!workspaceStore || typeof workspaceStore.readWorkspaceState !== "function" || !managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function" || typeof managedRuntimeClient.postJson !== "function" || !coordinator || typeof coordinator.recordServerRun !== "function") {
    throw new TypeError("Remote mutation adapter dependencies are invalid.");
  }

  const registration = (operation, validateArguments, execute, payloadVersions = [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION]) => ({
    operation,
    payloadVersions,
    requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES[operation]],
    validateArguments,
    execute,
  });

  return [
    registration("session.create", (value) => {
      const parsed = z.object({ workspaceId: identifierSchema, title: sessionCreateTitleSchema }).strict().parse(value);
      return Object.freeze(parsed);
    }, async ({ arguments: args }) => {
      try {
        const locallyAuthorized = (await localWorkspaces(workspaceStore)).find((entry) => entry.id === args.workspaceId);
        if (!locallyAuthorized) throw new RemoteControlOperationExecutionError("workspace_not_found");
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        if (workspace.workspaceType === "remote" || workspace.path !== locallyAuthorized.path) {
          throw new RemoteControlOperationExecutionError("workspace_not_found");
        }
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/sessions`,
          { title: args.title },
        );
        return createdSessionResult(response, workspace);
      } catch (error) {
        mapClientError(error, "workspace_not_found");
      }
    }),
    registration("session.prompt", (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || ![3, 4].includes(Object.keys(value).length)) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of ["workspaceId", "sessionId"]) {
        if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      if (typeof value.prompt !== "string" || value.prompt.trim().length < 1 || Buffer.byteLength(value.prompt, "utf8") > 200_000) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      const whenBusy = Object.hasOwn(value, "whenBusy") ? value.whenBusy : "reject";
      if (!["reject", "steer", "enqueue"].includes(whenBusy)) throw new TypeError("Remote mutation arguments are invalid.");
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), prompt: value.prompt, whenBusy });
    }, async ({ arguments: args, correlationId }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const session = await readSession(managedRuntimeClient, workspace.id, args.sessionId);
        if (canonicalPath(session.directory) !== workspace.path) {
          throw new RemoteControlOperationExecutionError("session_not_found");
        }
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(args.sessionId)}/runs/start`,
          { origin: "remote-control", startCommandCorrelationId: correlationId, whenBusy: args.whenBusy, prompt: { parts: [{ type: "text", text: args.prompt }] } },
        );
        if (!response || typeof response !== "object") throw new TypeError("Invalid start response.");
        const responseRecord = /** @type {Record<string, any>} */ (response);
        let result;
        if ("run" in responseRecord) {
          const run = responseRecord.run;
          if (!coordinator.recordServerRun(run)) throw new TypeError("Stale start response.");
          const recordedRun = /** @type {{ runId: string, generation: number }} */ (run);
          result = { disposition: "started", runId: recordedRun.runId, generation: recordedRun.generation };
        } else if (responseRecord.disposition === "enqueued" && identifierSchema.safeParse(responseRecord.pendingOperationId).success && Number.isSafeInteger(responseRecord.position) && responseRecord.position > 0) {
          result = { disposition: "enqueued", pendingOperationId: responseRecord.pendingOperationId, position: responseRecord.position };
        } else if (responseRecord.disposition === "steered" && identifierSchema.safeParse(responseRecord.pendingOperationId).success && identifierSchema.safeParse(responseRecord.admittedId).success) {
          result = { disposition: "steered", pendingOperationId: responseRecord.pendingOperationId, admittedId: responseRecord.admittedId };
        } else throw new TypeError("Invalid start response.");
        return desktopRemoteOperationResultSchema.parse({ operation: "session.prompt", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
    }),
    registration("session.pending.cancel", (value) => {
      parseArguments(value, ["workspaceId", "sessionId", "pendingOperationId"]);
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), pendingOperationId: String(value.pendingOperationId) });
    }, async ({ arguments: args, correlationId }) => {
      try {
        await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(args.workspaceId)}/sessions/${encodeURIComponent(args.sessionId)}/pending/${encodeURIComponent(args.pendingOperationId)}/cancel`,
          { commandCorrelationId: correlationId },
        );
        const responseRecord = /** @type {Record<string, any>} */ (response);
        if (!response || typeof response !== "object" || responseRecord.pendingOperationId !== args.pendingOperationId ||
          !["cancelled", "already_cancelled", "not_cancellable"].includes(responseRecord.status)) throw new TypeError("Invalid cancel response.");
        return desktopRemoteOperationResultSchema.parse({ operation: "session.pending.cancel", payloadVersion: 1, result: responseRecord }).result;
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
    }),
    registration("session.abort", (value) => {
      parseArguments(value, ["workspaceId", "sessionId", "expectedRunId"]);
      return Object.freeze({ workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), expectedRunId: String(value.expectedRunId) });
    }, async ({ arguments: args, correlationId }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(args.sessionId)}/runs/${encodeURIComponent(args.expectedRunId)}/abort`,
          { abortCommandCorrelationId: correlationId },
        );
        if (!response || typeof response !== "object" || !("run" in response) || !("abortRequested" in response) || response.abortRequested !== true ||
            !coordinator.recordServerRun(response.run)) throw new TypeError("Invalid abort response.");
        const recordedRun = /** @type {{ runId: string }} */ (response.run);
        const result = { runId: recordedRun.runId, abortRequested: true };
        return desktopRemoteOperationResultSchema.parse({ operation: "session.abort", payloadVersion: 1, result }).result;
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
    }),
    registration("interaction.permission.reply", (value, payloadVersion) => {
      const keys = payloadVersion === 2
        ? ["workspaceId", "rootSessionId", "targetSessionId", "parentSessionId", "interactionId", "response"]
        : ["workspaceId", "sessionId", "interactionId", "response"];
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of payloadVersion === 2 ? ["workspaceId", "rootSessionId", "targetSessionId", "interactionId"] : ["workspaceId", "sessionId", "interactionId"]) {
        if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
          throw new TypeError("Remote mutation arguments are invalid.");
        }
      }
      if (value.response !== "allow_once" && value.response !== "reject") {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      if (payloadVersion === 2 && !(value.parentSessionId === null || identifierSchema.safeParse(value.parentSessionId).success)) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      return Object.freeze(payloadVersion === 2
        ? { workspaceId: String(value.workspaceId), rootSessionId: String(value.rootSessionId), targetSessionId: String(value.targetSessionId), parentSessionId: value.parentSessionId, interactionId: String(value.interactionId), response: value.response }
        : { workspaceId: String(value.workspaceId), sessionId: String(value.sessionId), interactionId: String(value.interactionId), response: value.response });
    }, async ({ arguments: args, correlationId, payloadVersion = 1, context }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const boundRootSessionId = context?.remoteSessionBinding?.rootSessionId;
        const expectedRootSessionId = payloadVersion === 2 ? args.rootSessionId : args.sessionId;
        const targetSessionId = payloadVersion === 2 ? args.targetSessionId : args.sessionId;
        if (!identifierSchema.safeParse(boundRootSessionId).success || boundRootSessionId !== expectedRootSessionId ||
            !interactions || typeof interactions.resolveOwnership !== "function") {
          throw new RemoteControlOperationExecutionError("interaction_not_found");
        }
        const ownership = await interactions.resolveOwnership({ workspaceId: workspace.id, targetSessionId });
        const owner = ownership && typeof ownership === "object" ? /** @type {Record<string, unknown>} */ (ownership) : null;
        if (!owner || owner.rootSessionId !== boundRootSessionId || owner.targetSessionId !== targetSessionId ||
            (payloadVersion === 2 && owner.parentSessionId !== args.parentSessionId)) {
          throw new RemoteControlOperationExecutionError("interaction_not_found");
        }
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(targetSessionId)}/interactions/${encodeURIComponent(args.interactionId)}/permission/reply`,
          { origin: "remote-control", commandCorrelationId: correlationId, rootSessionId: boundRootSessionId, response: args.response },
        );
        return desktopRemoteOperationResultSchema.parse({
          operation: "interaction.permission.reply",
          payloadVersion,
          result: resolvedInteractionResult(response, args.interactionId, "interaction.permission.reply"),
        }).result;
      } catch (error) {
        mapInteractionClientError(error);
      }
    }, [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION, REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION]),
    registration("interaction.question.reply", (value, payloadVersion) => {
      const keys = payloadVersion === 2
        ? ["workspaceId", "rootSessionId", "targetSessionId", "parentSessionId", "interactionId", "answers"]
        : ["workspaceId", "sessionId", "interactionId", "answers"];
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      for (const key of payloadVersion === 2 ? ["workspaceId", "rootSessionId", "targetSessionId", "interactionId"] : ["workspaceId", "sessionId", "interactionId"]) {
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
      if (payloadVersion === 2 && !(value.parentSessionId === null || identifierSchema.safeParse(value.parentSessionId).success)) {
        throw new TypeError("Remote mutation arguments are invalid.");
      }
      return Object.freeze({
        workspaceId: String(value.workspaceId),
        ...(payloadVersion === 2
          ? { rootSessionId: String(value.rootSessionId), targetSessionId: String(value.targetSessionId), parentSessionId: value.parentSessionId }
          : { sessionId: String(value.sessionId) }),
        interactionId: String(value.interactionId),
        answers: value.answers.map((/** @type {Record<string, unknown>} */ a) => ({ questionId: String(a.questionId), values: /** @type {string[]} */ (a.values) })),
      });
    }, async ({ arguments: args, correlationId, payloadVersion = 1, context }) => {
      try {
        const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
        const boundRootSessionId = context?.remoteSessionBinding?.rootSessionId;
        const expectedRootSessionId = payloadVersion === 2 ? args.rootSessionId : args.sessionId;
        const targetSessionId = payloadVersion === 2 ? args.targetSessionId : args.sessionId;
        if (!identifierSchema.safeParse(boundRootSessionId).success || boundRootSessionId !== expectedRootSessionId ||
            !interactions || typeof interactions.resolveOwnership !== "function") {
          throw new RemoteControlOperationExecutionError("interaction_not_found");
        }
        const ownership = await interactions.resolveOwnership({ workspaceId: workspace.id, targetSessionId });
        const owner = ownership && typeof ownership === "object" ? /** @type {Record<string, unknown>} */ (ownership) : null;
        if (!owner || owner.rootSessionId !== boundRootSessionId || owner.targetSessionId !== targetSessionId ||
            (payloadVersion === 2 && owner.parentSessionId !== args.parentSessionId)) {
          throw new RemoteControlOperationExecutionError("interaction_not_found");
        }
        const response = await managedRuntimeClient.postJson(
          `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(targetSessionId)}/interactions/${encodeURIComponent(args.interactionId)}/question/reply`,
          { origin: "remote-control", commandCorrelationId: correlationId, rootSessionId: boundRootSessionId, answers: args.answers },
        );
        return desktopRemoteOperationResultSchema.parse({
          operation: "interaction.question.reply",
          payloadVersion,
          result: resolvedInteractionResult(response, args.interactionId, "interaction.question.reply"),
        }).result;
      } catch (error) {
        mapInteractionClientError(error);
      }
    }, [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION, REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION]),
  ];
}
