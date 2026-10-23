import type { ReviewConnectionStatus } from "@jugglework/types/reviews";

/** Recover the Connect transport once before asking the member to reconnect GitHub. */
export async function readReviewConnectionWithRecovery(input: {
  readConnection: () => Promise<ReviewConnectionStatus>;
  repairTransport: () => Promise<unknown>;
  isScopeCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<ReviewConnectionStatus> {
  const checkScope = () => {
    input.signal?.throwIfAborted();
    if (!input.isScopeCurrent()) throw new DOMException("Review connection context changed.", "AbortError");
  };
  checkScope();
  const connection = await input.readConnection();
  checkScope();
  if (connection.state !== "unavailable") return connection;
  try {
    await input.repairTransport();
  } catch {
    checkScope();
    return connection;
  }
  checkScope();
  // Review reads need the transport, even if engine tool projection is still
  // unhealthy. Re-read once rather than depending on engine readiness.
  const recovered = await input.readConnection();
  checkScope();
  return recovered;
}
