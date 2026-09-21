import { desktopFetch } from "@/app/lib/desktop";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import {
  acquireMicrophone,
  releaseMicrophone,
  requestMicrophoneAccess,
  type MicrophonePermissionResult,
} from "../../voice/microphone";

export type VoiceDictationPhase =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "recording"
  | "transcribing"
  | "error";

export type VoiceDictationErrorCode =
  | "microphone_busy"
  | "permission_denied"
  | "service_unavailable"
  | "connection_failed"
  | "transcription_failed"
  | "transcription_timeout";

export type VoiceDictationSnapshot = {
  phase: VoiceDictationPhase;
  errorCode?: VoiceDictationErrorCode;
  errorMessage?: string;
};

type RealtimeSession = Awaited<ReturnType<JuggleWorkServerClient["createVoiceRealtimeSession"]>>;

type VoiceDictationDependencies = {
  requestPermission: () => Promise<MicrophonePermissionResult>;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
  exchangeSdp: (clientSecret: string, sdp: string) => Promise<string>;
  acquireMicrophone: typeof acquireMicrophone;
  releaseMicrophone: typeof releaseMicrophone;
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
};

type VoiceDictationControllerOptions = {
  sessionId: string;
  createSession: () => Promise<RealtimeSession>;
  onSnapshot: (snapshot: VoiceDictationSnapshot) => void;
  onTranscript: (text: string) => void;
  onEmpty: () => void;
  dependencies?: Partial<VoiceDictationDependencies>;
  maxRecordingMs?: number;
  transcriptionTimeoutMs?: number;
};

const DEFAULT_MAX_RECORDING_MS = 5 * 60_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 20_000;
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

function defaultDependencies(): VoiceDictationDependencies {
  return {
    requestPermission: requestMicrophoneAccess,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    exchangeSdp: async (clientSecret, sdp) => {
      const response = await desktopFetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: sdp,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenAI Realtime SDP failed: ${response.status} ${detail}`.trim());
      }
      return response.text();
    },
    acquireMicrophone,
    releaseMicrophone,
    setTimeout: globalThis.setTimeout.bind(globalThis) as typeof window.setTimeout,
    clearTimeout: globalThis.clearTimeout.bind(globalThis) as typeof window.clearTimeout,
  };
}

function waitForDataChannelOpen(
  channel: RTCDataChannel,
  deps: Pick<VoiceDictationDependencies, "setTimeout" | "clearTimeout">,
) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      deps.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Realtime data channel closed before opening."));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Realtime data channel failed."));
    };
    const timeout = deps.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel did not open in time."));
    }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function waitForSessionUpdated(
  channel: RTCDataChannel,
  deps: Pick<VoiceDictationDependencies, "setTimeout" | "clearTimeout">,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      deps.clearTimeout(timeout);
      channel.removeEventListener("message", handleMessage);
      channel.removeEventListener("close", handleClose);
    };
    const handleMessage = (message: MessageEvent) => {
      try {
        const event = JSON.parse(String(message.data)) as { type?: string };
        if (event.type !== "session.updated") return;
        cleanup();
        resolve();
      } catch {
        // Other Realtime events are handled by the controller listener.
      }
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Realtime data channel closed before dictation was configured."));
    };
    const timeout = deps.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime dictation configuration timed out."));
    }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
    channel.addEventListener("message", handleMessage);
    channel.addEventListener("close", handleClose);
  });
}

function errorDetails(error: unknown): { code: VoiceDictationErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const structuredCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (
    structuredCode === "openai_api_key_missing" ||
    structuredCode === "jugglework_models_voice_unavailable" ||
    normalized.includes("openai_api_key_missing") ||
    normalized.includes("not fully configured") ||
    normalized.includes("api key missing") ||
    normalized.includes("voice unavailable")
  ) {
    return { code: "service_unavailable", message };
  }
  return { code: "connection_failed", message };
}

export class VoiceDictationController {
  private readonly owner: string;
  private readonly deps: VoiceDictationDependencies;
  private readonly maxRecordingMs: number;
  private readonly transcriptionTimeoutMs: number;
  private snapshot: VoiceDictationSnapshot = { phase: "idle" };
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private recordingTimer: number | null = null;
  private transcriptionTimer: number | null = null;
  private generation = 0;
  private transcriptDelivered = false;
  private hasLease = false;

  constructor(private readonly options: VoiceDictationControllerOptions) {
    this.owner = `composer-dictation:${options.sessionId}`;
    this.deps = { ...defaultDependencies(), ...options.dependencies };
    this.maxRecordingMs = options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  }

  getSnapshot() {
    return this.snapshot;
  }

  private publish(snapshot: VoiceDictationSnapshot) {
    this.snapshot = snapshot;
    this.options.onSnapshot(snapshot);
  }

  private clearTimers() {
    if (this.recordingTimer !== null) this.deps.clearTimeout(this.recordingTimer);
    if (this.transcriptionTimer !== null) this.deps.clearTimeout(this.transcriptionTimer);
    this.recordingTimer = null;
    this.transcriptionTimer = null;
  }

  private cleanup() {
    this.clearTimers();
    try {
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {}
    this.stream = null;
    try {
      this.channel?.close();
    } catch {}
    this.channel = null;
    try {
      this.peer?.close();
    } catch {}
    this.peer = null;
    if (this.hasLease) {
      this.deps.releaseMicrophone(this.owner);
      this.hasLease = false;
    }
  }

  private fail(code: VoiceDictationErrorCode, errorMessage?: string) {
    this.cleanup();
    this.publish({ phase: "error", errorCode: code, errorMessage });
  }

  private handleMessage = (raw: string, generation: number) => {
    if (generation !== this.generation) return;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (this.snapshot.phase !== "transcribing" || this.transcriptDelivered) return;
      this.transcriptDelivered = true;
      const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
      this.cleanup();
      this.publish({ phase: "idle" });
      if (transcript) this.options.onTranscript(transcript);
      else this.options.onEmpty();
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.failed" || event.type === "error") {
      const error = event.error && typeof event.error === "object" && !Array.isArray(event.error)
        ? event.error as Record<string, unknown>
        : null;
      const message = typeof error?.message === "string" ? error.message : undefined;
      this.fail("transcription_failed", message);
    }
  };

  async start() {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") return false;
    if (
      !this.options.dependencies?.getUserMedia &&
      (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    ) {
      this.fail("connection_failed", "Microphone capture is unavailable in this runtime.");
      return false;
    }

    const lease = this.deps.acquireMicrophone(this.owner);
    if (!lease.ok) {
      this.publish({ phase: "error", errorCode: "microphone_busy" });
      return false;
    }
    this.hasLease = true;
    this.transcriptDelivered = false;
    const generation = ++this.generation;
    this.publish({ phase: "requesting-permission" });

    try {
      const permission = await this.deps.requestPermission();
      if (generation !== this.generation) return false;
      if (!permission.granted) {
        this.fail("permission_denied", permission.status);
        return false;
      }

      this.publish({ phase: "connecting" });
      const realtimeSession = await this.options.createSession();
      if (generation !== this.generation) return false;
      const stream = await this.deps.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;

      const peer = this.deps.createPeerConnection();
      this.peer = peer;
      for (const track of stream.getAudioTracks()) {
        // Keep capture muted until the defensive session.update is accepted by
        // the data channel. This prevents an older managed broker's default VAD
        // settings from creating an assistant response during connection setup.
        track.enabled = false;
        peer.addTrack(track, stream);
      }

      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.handleMessage(String(event.data), generation));
      channel.addEventListener("close", () => {
        if (generation !== this.generation || this.snapshot.phase === "idle" || this.snapshot.phase === "error") return;
        this.fail("connection_failed", "Realtime data channel closed.");
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("Realtime offer did not include SDP.");
      const answer = await this.deps.exchangeSdp(realtimeSession.clientSecret, offer.sdp);
      if (generation !== this.generation) return false;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      await waitForDataChannelOpen(channel, this.deps);
      if (generation !== this.generation) return false;

      const sessionUpdated = waitForSessionUpdated(channel, this.deps);
      channel.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["text"],
          audio: {
            input: {
              transcription: { model: realtimeSession.transcriptionModel },
              turn_detection: null,
              noise_reduction: { type: "near_field" },
            },
          },
          tools: [],
          tool_choice: "none",
        },
      }));
      await sessionUpdated;
      if (generation !== this.generation) return false;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      this.publish({ phase: "recording" });
      this.recordingTimer = this.deps.setTimeout(() => void this.stop(), this.maxRecordingMs);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const details = errorDetails(error);
      this.fail(details.code, details.message);
      return false;
    }
  }

  async stop() {
    if (this.snapshot.phase === "requesting-permission" || this.snapshot.phase === "connecting") {
      this.cancel();
      return false;
    }
    if (this.snapshot.phase !== "recording") return false;
    if (this.recordingTimer !== null) this.deps.clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });

    const channel = this.channel;
    if (!channel || channel.readyState !== "open") {
      this.fail("connection_failed", "Realtime data channel is not open.");
      return false;
    }

    this.publish({ phase: "transcribing" });
    channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.transcriptionTimer = this.deps.setTimeout(() => {
      this.fail("transcription_timeout");
    }, this.transcriptionTimeoutMs);
    return true;
  }

  cancel() {
    this.generation += 1;
    this.cleanup();
    this.publish({ phase: "idle" });
  }

  dispose() {
    this.generation += 1;
    this.cleanup();
  }
}
