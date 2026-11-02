// One in-flight pull and one awaited xterm write: neither IPC nor the xterm
// parser queue grows with producer throughput. Cursors count UTF-16 code units.
export function captureTerminalTarget<T extends { workspaceId: string; sessionId: string; isRemoteWorkspace: boolean }>(target: T) {
  return { workspaceId: target.workspaceId, sessionId: target.sessionId, isRemoteWorkspace: target.isRemoteWorkspace };
}

export async function consumeTerminalOutput(
  cursor: number,
  response: { cursor: number; data: string; gap: boolean },
  write: (text: string) => Promise<void>,
) {
  if (response.cursor < cursor) throw new Error("Terminal cursor moved backwards");
  if (response.gap) await write("\x1bc\r\n[Output truncated; terminal screen may be incomplete]\r\n");
  if (response.data) await write(response.data);
  return response.cursor;
}
