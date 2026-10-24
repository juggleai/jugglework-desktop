import type { SessionFileArtifacts, TurnDelivery } from "@jugglework/types/file-artifacts";
import type { OpenTarget } from "../artifacts/open-target";

const consumed = new Set<string>();
const STORAGE_PREFIX = "jugglework:presentation-opened:v1:";

export type PresentationDeliveryMatch = { artifactId: string; target: OpenTarget };

export function resolvePresentationDelivery(
  data: SessionFileArtifacts | undefined,
  sessionId: string,
  turnId: string,
): PresentationDeliveryMatch | null {
  const turn: TurnDelivery | undefined = data?.turns.find((entry) => entry.sessionId === sessionId && entry.turnId === turnId);
  if (!turn || turn.status !== "ready") return null;
  const files = new Map(data!.files.map((file) => [file.artifactId, file]));
  const matches = turn.items.flatMap((item) => {
    const file = files.get(item.artifactId);
    if (!file || !file.exists || !file.relativePath.toLowerCase().endsWith(".pptx")) return [];
    return [{
      artifactId: item.artifactId,
      target: {
        id: item.artifactId,
        kind: "file" as const,
        value: file.relativePath,
        name: item.snapshot.name || file.name,
        preview: "slides" as const,
        confidence: 100,
        reason: "presentation-creation",
        exists: true,
        size: file.sizeBytes ?? undefined,
        updatedAt: file.updatedAt ?? undefined,
      },
    }];
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function presentationDeliveryTerminal(data: SessionFileArtifacts | undefined, sessionId: string, turnId: string): boolean {
  const status = data?.turns.find((entry) => entry.sessionId === sessionId && entry.turnId === turnId)?.status;
  return status === "ready" || status === "partial" || status === "failed";
}

export function consumePresentationDelivery(workspaceId: string, sessionId: string, turnId: string, artifactId: string): boolean {
  const key = `${workspaceId}:${sessionId}:${turnId}:${artifactId}`;
  if (consumed.has(key)) return false;
  try {
    if (globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${key}`) === "1") return false;
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${key}`, "1");
  } catch {
    // In-memory deduplication remains authoritative when storage is unavailable.
  }
  consumed.add(key);
  return true;
}

export function resetPresentationDeliveryConsumptionForTest(): void {
  consumed.clear();
}
