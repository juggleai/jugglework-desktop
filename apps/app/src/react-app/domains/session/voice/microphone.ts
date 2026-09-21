export type MicrophonePermissionResult = {
  granted: boolean;
  platform: string;
  status: string;
};

let microphoneOwner: string | null = null;

export function acquireMicrophone(owner: string) {
  if (!owner.trim()) return { ok: false as const, owner: microphoneOwner };
  if (microphoneOwner && microphoneOwner !== owner) {
    return { ok: false as const, owner: microphoneOwner };
  }
  microphoneOwner = owner;
  return { ok: true as const };
}

export function releaseMicrophone(owner: string) {
  if (microphoneOwner !== owner) return false;
  microphoneOwner = null;
  return true;
}

export function getMicrophoneOwner() {
  return microphoneOwner;
}

export async function requestMicrophoneAccess(): Promise<MicrophonePermissionResult> {
  const ask = window.__JUGGLEWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (!ask) return { granted: true, platform: "browser", status: "prompt" };

  const result = await ask();
  const status = result.after ?? result.before ?? result.status ?? "unknown";
  return {
    granted: result.platform !== "darwin" || result.granted,
    platform: result.platform,
    status,
  };
}

