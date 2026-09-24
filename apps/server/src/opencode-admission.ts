import { createHash } from "node:crypto";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "./errors.js";

type Client = ReturnType<typeof createOpencodeClient>;
type PromptParameters = Parameters<Client["v2"]["session"]["prompt"]>[0];

export interface AdmissionIdentity {
  workspaceId: string;
  sessionId: string;
  source: "local-steer" | "local-queue" | "remote-pending";
  id: string;
}

/** Keep correlation IDs separate from engine message IDs. Never change this
 * mapping on retry/restart: an unknown outcome may already be committed upstream.
 * Payload and delivery are intentionally excluded so changed retries conflict.
 */
export function opencodeAdmissionId(identity: AdmissionIdentity): string {
  // Older servers forwarded valid engine IDs unchanged. Preserve these on
  // upgrade so a lost-response retry cannot execute an already admitted input twice.
  if (identity.id.startsWith("msg_")) return identity.id;
  const digest = createHash("sha256")
    .update(JSON.stringify(["jugglework-admission-v1", identity.workspaceId, identity.sessionId, identity.source, identity.id]))
    .digest("hex");
  return `msg_${digest}`;
}

/** Admit without exposing upstream bodies (which can contain prompts or secrets).
 * Only a verified success is acceptance; transport failures remain ambiguous.
 */
export async function admitOpencodePrompt(
  client: Client,
  input: AdmissionIdentity & { prompt: PromptParameters["prompt"]; delivery: "steer" | "queue" },
  signal?: AbortSignal,
): Promise<void> {
  const id = opencodeAdmissionId(input);
  const path = `/api/session/${encodeURIComponent(input.sessionId)}/prompt`;
  let result;
  try {
    result = await client.v2.session.prompt({
      sessionID: input.sessionId,
      id,
      prompt: input.prompt,
      delivery: input.delivery,
    }, { signal });
  } catch {
    throw new ApiError(502, "opencode_admission_unconfirmed", "OpenCode prompt admission could not be confirmed", { path });
  }
  const status = result.response?.status;
  if (result.error !== undefined || (status !== undefined && (status < 200 || status >= 300))) {
    const details = { path, ...(status === undefined ? {} : { status }) };
    switch (status) {
      case 400:
        throw new ApiError(502, "opencode_admission_invalid_request", "OpenCode rejected the prompt request format", details);
      case 401:
      case 403:
        throw new ApiError(502, "opencode_admission_unauthorized", "OpenCode prompt admission was not authorized", details);
      case 404:
        throw new ApiError(502, "opencode_admission_not_found", "OpenCode prompt endpoint or session was not found", details);
      case 409:
        throw new ApiError(409, "opencode_admission_conflict", "OpenCode rejected a conflicting prompt admission; retry with the original content", details);
      default:
        throw new ApiError(502, "opencode_admission_unconfirmed", "OpenCode prompt admission could not be confirmed", details);
    }
  }
  const admitted = result.data?.data;
  if (!admitted || admitted.id !== id || admitted.sessionID !== input.sessionId || admitted.delivery !== input.delivery) {
    throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an invalid prompt admission response", { path, status });
  }
}
