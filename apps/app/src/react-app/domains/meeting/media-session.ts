// Shared device arbitration only. Meeting never calls JuggleCall APIs.
let owner: "call" | "meeting" | null = null;
export function acquireMediaSession(next: NonNullable<typeof owner>) {
  if (owner && owner !== next)
    throw new Error("已有音视频会话正在进行，请先结束当前会话。");
  owner = next;
}
export function releaseMediaSession(current: NonNullable<typeof owner>) {
  if (owner === current) owner = null;
}
