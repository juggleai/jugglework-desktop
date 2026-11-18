import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useParticipantSounds } from "../src/react-app/domains/meeting/use-participant-sounds";
import type { Meeting } from "../src/react-app/domains/meeting/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function Probe({ ids, enabled, session }: { ids: string[]; enabled: boolean; session: string }) {
  const participants = Object.fromEntries(ids.map(userId => [userId, { userId, sessionId: session }]));
  useParticipantSounds({ id: "room", organizationId: "org", participants } as Meeting, "me", enabled);
  return null;
}

test("audio is silent on admission, preference enable and rejoin; remote membership changes coalesce", async () => {
  const pitch = mock((hz: number) => {});
  const old = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  class Audio {
    currentTime = 0;
    createOscillator() { return { frequency: { setValueAtTime: pitch, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node, start() {}, stop() { this.onended?.(); }, onended: null as (() => void) | null }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
    async close() {}
  }
  Object.defineProperty(globalThis, "AudioContext", { value: Audio, configurable: true });
  let tree: ReactTestRenderer | undefined;
  const render = (ids: string[], enabled = true, session = "s1") => act(async () => {
    const node = <Probe ids={ids} enabled={enabled} session={session} />;
    if (tree) tree.update(node); else tree = create(node);
  });
  try {
    await render(["me", "A", "B"]);
    await render(["B", "A", "me"]);
    expect(pitch).not.toHaveBeenCalled();
    await render(["me", "A", "B", "C", "D"]);
    await render(["me", "A"]); // within cooldown: no backlog
    expect(pitch.mock.calls.map(([hz]) => hz)).toEqual([440]);
    await render(["me"], false);
    await render(["me", "E"]);
    await render(["me", "F", "G"], true, "new-session");
    expect(pitch).toHaveBeenCalledTimes(1);
    await render(["me"], true, "new-session");
    expect(pitch.mock.calls.map(([hz]) => hz)).toEqual([440, 660]);
    await render([]);
    expect(pitch).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => { tree?.unmount(); });
    if (old) Object.defineProperty(globalThis, "AudioContext", old); else Reflect.deleteProperty(globalThis, "AudioContext");
  }
});
