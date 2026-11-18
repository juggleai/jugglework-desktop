export type MeetingShareKind = "screen" | "whiteboard";
export type MemberDeviceState = { mic: boolean; camera: boolean; shareKind?: MeetingShareKind; sessionId: string; seq: number; receivedAt: number };
export function acceptDeviceState(content: Record<string, unknown>, sessionId: string, previous?: MemberDeviceState, now = Date.now()): MemberDeviceState | null {
  if (content.sessionId !== sessionId || typeof content.mic !== "boolean" ||
      typeof content.camera !== "boolean" || !Number.isSafeInteger(content.seq) || Number(content.seq) < 1) return null;
  if (previous?.sessionId === sessionId && previous.seq >= Number(content.seq)) return null;
  const shareKind = content.shareKind === "screen" || content.shareKind === "whiteboard" ? content.shareKind : undefined;
  return { mic: content.mic, camera: content.camera, ...(shareKind ? { shareKind } : {}), sessionId, seq: Number(content.seq), receivedAt: now };
}
