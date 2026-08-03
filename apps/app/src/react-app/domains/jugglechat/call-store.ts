import { create } from "zustand";

import { juggleChatRuntime } from "./runtime";
import type { ChatConversation } from "./types";

type CallState = {
  initialized: boolean;
  client: any;
  session: any;
  callId: string | null;
  peerName: string;
  peerPortrait?: string;
  mediaType: number;
  phase: "idle" | "incoming" | "calling" | "connected";
  mutedMic: boolean;
  mutedCamera: boolean;
  error: string | null;
  initialize: () => Promise<any>;
  start: (conversation: ChatConversation, video: boolean) => Promise<void>;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  clearError: () => void;
};

function eventCallId(event: any) {
  return event?.callId ?? event?.target?.callId ?? null;
}

export const useJuggleCallStore = create<CallState>((set, get) => ({
  initialized: false,
  client: null,
  session: null,
  callId: null,
  peerName: "",
  mediaType: 0,
  phase: "idle",
  mutedMic: false,
  mutedCamera: true,
  error: null,

  async initialize() {
    if (get().client) return get().client;
    const client = await juggleChatRuntime.getCallClient();
    if (!get().initialized) {
      const { CallEvent } = client;
      client.on(CallEvent.INVITED, (event: any) => {
        const callId = eventCallId(event);
        const session = callId ? client.getSession({ callId }) : null;
        if (!session || get().phase !== "idle") return;
        set({
          session,
          callId,
          peerName: session.inviter?.name || session.inviter?.id || "JuggleChat 用户",
          peerPortrait: session.inviter?.portrait,
          mediaType: session.mediaType ?? 0,
          phase: "incoming",
          mutedCamera: (session.mediaType ?? 0) !== 1,
        });
      });
      client.on(CallEvent.CALL_CONNECTED, (event: any) => {
        if (eventCallId(event) === get().callId) set({ phase: "connected" });
      });
      client.on(CallEvent.CALL_FINISHED, (event: any) => {
        if (eventCallId(event) === get().callId) {
          set({ session: null, callId: null, phase: "idle", mutedMic: false, mutedCamera: true });
        }
      });
      client.on(CallEvent.MEMBER_JOINED, (event: any) => {
        if (eventCallId(event) === get().callId) set({ session: client.getSession({ callId: get().callId }) });
      });
      client.on(CallEvent.CAMERA_CHANGED, (event: any) => {
        if (eventCallId(event) === get().callId) set({ session: client.getSession({ callId: get().callId }) });
      });
    }
    set({ client, initialized: true });
    return client;
  },

  async start(conversation, video) {
    if (get().phase !== "idle") return;
    try {
      const client = await get().initialize();
      const session = client.create();
      const mediaType = video ? 1 : 0;
      set({
        session,
        callId: session.callId,
        peerName: conversation.conversationAlias || conversation.conversationTitle || conversation.conversationId,
        peerPortrait: conversation.conversationPortrait,
        mediaType,
        phase: "calling",
        mutedCamera: !video,
        error: null,
      });
      if (conversation.conversationType === 2) {
        set({ error: "群通话需要先从群成员中选择邀请对象" });
        session.hangup?.();
        set({ session: null, callId: null, phase: "idle" });
        return;
      }
      session.startSingleCall({ memberId: conversation.conversationId, mediaType, isEnableCamera: video });
    } catch (error) {
      set({ phase: "idle", session: null, callId: null, error: error instanceof Error ? error.message : String(error) });
    }
  },

  accept() {
    const { session, mediaType } = get();
    if (!session) return;
    const isEnableCamera = mediaType === 1;
    session.accept({ mediaType, isEnableCamera });
    set({ phase: "calling", mutedCamera: !isEnableCamera });
  },

  reject() {
    get().session?.hangup?.();
    set({ session: null, callId: null, phase: "idle" });
  },

  hangup() {
    get().session?.hangup?.();
    set({ session: null, callId: null, phase: "idle", mutedMic: false, mutedCamera: true });
  },

  toggleMic() {
    const mutedMic = !get().mutedMic;
    get().session?.muteMicrophone?.(mutedMic);
    set({ mutedMic });
  },

  toggleCamera() {
    const mutedCamera = !get().mutedCamera;
    get().session?.muteCamera?.(mutedCamera);
    set({ mutedCamera });
  },

  clearError() {
    set({ error: null });
  },
}));

