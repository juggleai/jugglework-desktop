import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireMicrophone,
  getMicrophoneOwner,
  releaseMicrophone,
} from "../src/react-app/domains/session/voice/microphone";

const OWNERS = ["voice-mode", "composer-dictation:test"];

afterEach(() => {
  for (const owner of OWNERS) releaseMicrophone(owner);
});

describe("microphone lease", () => {
  test("allows one voice feature at a time without interrupting the current owner", () => {
    expect(acquireMicrophone("voice-mode")).toEqual({ ok: true });
    expect(acquireMicrophone("composer-dictation:test")).toEqual({ ok: false, owner: "voice-mode" });
    expect(getMicrophoneOwner()).toBe("voice-mode");
  });

  test("releases only from the current owner", () => {
    acquireMicrophone("voice-mode");
    expect(releaseMicrophone("composer-dictation:test")).toBeFalse();
    expect(releaseMicrophone("voice-mode")).toBeTrue();
    expect(getMicrophoneOwner()).toBeNull();
  });
});

