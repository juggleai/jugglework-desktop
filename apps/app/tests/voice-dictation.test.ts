import { describe, expect, test } from "bun:test";
import {
  VoiceDictationController,
  type VoiceDictationSnapshot,
} from "../src/react-app/domains/session/surface/composer/voice-dictation";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly sent: string[] = [];

  send(value: string) {
    this.sent.push(value);
    const payload = JSON.parse(value) as { type?: string };
    if (payload.type === "session.update") {
      queueMicrotask(() => this.emit({ type: "session.updated" }));
    }
  }

  close() {
    this.readyState = "closed";
  }

  emit(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

function setup(options: { lease?: boolean; maxRecordingMs?: number; permission?: boolean; timeoutMs?: number } = {}) {
  const channel = new FakeDataChannel();
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const peer = {
    closed: false,
    addTrack: () => undefined,
    createDataChannel: () => channel as unknown as RTCDataChannel,
    createOffer: async () => ({ type: "offer", sdp: "offer-sdp" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined,
    close() {
      this.closed = true;
    },
  } as unknown as RTCPeerConnection & { closed: boolean };
  const snapshots: VoiceDictationSnapshot[] = [];
  const transcripts: string[] = [];
  let emptyCount = 0;
  let released = 0;
  const controller = new VoiceDictationController({
    sessionId: "session-test",
    createSession: async () => ({
      ok: true,
      clientSecret: "short-lived-secret",
      expiresAt: null,
      model: "gpt-realtime-2",
      transcriptionModel: "gpt-4o-transcribe",
      tools: [],
    }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onTranscript: (text) => transcripts.push(text),
    onEmpty: () => { emptyCount += 1; },
    maxRecordingMs: options.maxRecordingMs,
    transcriptionTimeoutMs: options.timeoutMs ?? 100,
    dependencies: {
      requestPermission: async () => ({
        granted: options.permission ?? true,
        platform: "test",
        status: options.permission === false ? "denied" : "granted",
      }),
      getUserMedia: async () => stream,
      createPeerConnection: () => peer,
      exchangeSdp: async () => "answer-sdp",
      acquireMicrophone: () => options.lease === false
        ? { ok: false, owner: "voice-mode" }
        : { ok: true },
      releaseMicrophone: () => {
        released += 1;
        return true;
      },
    },
  });

  return { channel, controller, emptyCount: () => emptyCount, peer, released: () => released, snapshots, track, transcripts };
}

describe("voice dictation controller", () => {
  test("records, commits manually, and delivers one final transcript", async () => {
    const state = setup();
    expect(await state.controller.start()).toBeTrue();
    expect(state.controller.getSnapshot().phase).toBe("recording");

    const sessionUpdate = JSON.parse(state.channel.sent[0]!) as {
      type: string;
      session: { audio: { input: { transcription: { language?: string }; turn_detection: unknown } }; tools: unknown[] };
    };
    expect(sessionUpdate.type).toBe("session.update");
    expect(sessionUpdate.session.audio.input.transcription.language).toBeUndefined();
    expect(sessionUpdate.session.audio.input.turn_detection).toBeNull();
    expect(sessionUpdate.session.tools).toEqual([]);

    expect(await state.controller.stop()).toBeTrue();
    expect(state.track.enabled).toBeFalse();
    expect(JSON.parse(state.channel.sent.at(-1)!)).toEqual({ type: "input_audio_buffer.commit" });
    expect(state.controller.getSnapshot().phase).toBe("transcribing");

    state.channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "  中英 mixed input  ",
    });
    state.channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "duplicate",
    });

    expect(state.transcripts).toEqual(["中英 mixed input"]);
    expect(state.controller.getSnapshot().phase).toBe("idle");
    expect(state.track.stopped).toBeTrue();
    expect(state.peer.closed).toBeTrue();
    expect(state.released()).toBe(1);
  });

  test("does not modify the draft for an empty transcription", async () => {
    const state = setup();
    await state.controller.start();
    await state.controller.stop();
    state.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "   " });

    expect(state.transcripts).toEqual([]);
    expect(state.emptyCount()).toBe(1);
    expect(state.controller.getSnapshot().phase).toBe("idle");
  });

  test("discards late results after navigation cancellation", async () => {
    const state = setup();
    await state.controller.start();
    await state.controller.stop();
    state.controller.cancel();
    state.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "stale" });

    expect(state.transcripts).toEqual([]);
    expect(state.controller.getSnapshot().phase).toBe("idle");
  });

  test("reports permission denial and releases the microphone", async () => {
    const state = setup({ permission: false });
    expect(await state.controller.start()).toBeFalse();
    expect(state.controller.getSnapshot()).toMatchObject({ phase: "error", errorCode: "permission_denied" });
    expect(state.released()).toBe(1);
  });

  test("does not interrupt another microphone owner", async () => {
    const state = setup({ lease: false });
    expect(await state.controller.start()).toBeFalse();
    expect(state.controller.getSnapshot()).toMatchObject({ phase: "error", errorCode: "microphone_busy" });
    expect(state.released()).toBe(0);
  });

  test("automatically commits at the recording limit", async () => {
    const state = setup({ maxRecordingMs: 5 });
    await state.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(state.controller.getSnapshot().phase).toBe("transcribing");
    expect(JSON.parse(state.channel.sent.at(-1)!)).toEqual({ type: "input_audio_buffer.commit" });
    state.controller.cancel();
  });

  test("times out while waiting for a final transcript", async () => {
    const state = setup({ timeoutMs: 5 });
    await state.controller.start();
    await state.controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(state.controller.getSnapshot()).toMatchObject({ phase: "error", errorCode: "transcription_timeout" });
    expect(state.transcripts).toEqual([]);
  });
});
