export type MemberDeviceState = { mic: boolean; camera: boolean; sessionId: string; seq: number; receivedAt: number };
export function acceptDeviceState(content: Record<string, unknown>, sessionId: string, previous?: MemberDeviceState, now = Date.now()): MemberDeviceState | null {
  if (content.sessionId !== sessionId || typeof content.mic !== "boolean" ||
      typeof content.camera !== "boolean" || !Number.isSafeInteger(content.seq) || Number(content.seq) < 1) return null;
  if (previous?.sessionId === sessionId && previous.seq >= Number(content.seq)) return null;
  return { mic: content.mic, camera: content.camera, sessionId, seq: Number(content.seq), receivedAt: now };
}
