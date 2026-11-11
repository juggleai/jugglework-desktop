// Test-only provider boundaries. Production MeetingRoomHost, store, media adapter
// and native Electron main/preload are used without a special production flag.
import React from "react";
import { createRoot } from "react-dom/client";
import { MeetingRoomHost } from "../../../src/react-app/domains/meeting/meeting-room";
import { useMeetingStore } from "../../../src/react-app/domains/meeting/store";
import { meetingAPI } from "../../../src/react-app/domains/meeting/api";
const qa: any = { actions: [], tracks: [], chatLeft: 0, failNext: false };
(window as any).__meetingQA = qa;
(window as any).__meetingTestAuth = {
  user: { id: "self", name: "测试用户" },
  activeOrganization: { id: "qa-org" },
};
let current: any;
Object.assign(meetingAPI, {
  join: async () => ({
    meeting: current,
    sessionId: "qa-session",
    chatroomId: "qa-chatroom",
    appId: 1,
    roomId: current.id,
    userId: "self",
    userName: "测试用户",
    token: "test-only",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  }),
  get: async () => ({ meeting: current }),
  action: async (_id: string, action: string) => {
    qa.actions.push(action);
    if (qa.failNext) {
      qa.failNext = false;
      throw new Error("测试：服务暂不可用，请重试");
    }
    if (action === "end") current = { ...current, status: "ended" };
    if (action === "leave") {
      current = {
        ...current,
        participants: { other: current.participants.other },
        hostId: "other",
      };
    }
    return { meeting: current };
  },
});
(window as any).ZegoExpressEngine = class {
  on() {}
  async loginRoom() {
    return true;
  }
  logoutRoom() {}
  destroyEngine() {}
  renewToken() {
    return true;
  }
  async createStream(options: any) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: options.camera.audio,
      video: options.camera.video,
    });
    qa.tracks.push(...stream.getTracks());
    return stream;
  }
  startPublishingStream() {
    return true;
  }
  stopPublishingStream() {}
  destroyStream(stream: MediaStream) {
    stream.getTracks().forEach((t) => t.stop());
  }
};
qa.start = async (role = "host") => {
  qa.actions = [];
  qa.chatLeft = 0;
  qa.tracks = [];
  qa.failNext = false;
  const now = new Date().toISOString();
  current = {
    id: crypto.randomUUID(),
    organizationId: "qa-org",
    title: `会议窗口验证 · ${role === "host" ? "主持人" : "普通成员"}`,
    code: "QA-ONLY",
    status: "live",
    sourceKind: "workbench",
    sourceId: "",
    organizerId: "other",
    hostId: role === "host" ? "self" : "other",
    version: 1,
    startAt: now,
    endAt: now,
    timezone: "Asia/Shanghai",
    invites: { self: "accepted" },
    participants: {
      self: {
        userId: "self",
        name: "测试用户",
        sessionId: "qa-session",
        joinedAt: now,
        lastSeenAt: now,
      },
      other: {
        userId: "other",
        name: "另一位参会者",
        sessionId: "other-session",
        joinedAt: now,
        lastSeenAt: now,
      },
    },
  };
  await useMeetingStore.getState().join(current, true, true);
};
qa.state = () => ({
  phase: useMeetingStore.getState().phase,
  actions: qa.actions,
  tracks: qa.tracks.map((t: MediaStreamTrack) => ({
    kind: t.kind,
    state: t.readyState,
  })),
  chatLeft: qa.chatLeft,
});
document.head.insertAdjacentHTML(
  "beforeend",
  "<style>:root{--background:#fff;--foreground:#202329;--border:#e4e6ea;--muted:#f5f6f8;--muted-foreground:#7b8190}body{margin:0;font:16px system-ui;background:#f7f7f8}main{padding:60px}main button{padding:12px;margin:8px;border-radius:12px;border:1px solid #ddd;background:white}</style>",
);
createRoot(document.getElementById("root")!).render(
  <>
    <main>
      <h1>Electron 会议窗口验证</h1>
      <p>
        测试身份与服务响应；摄像头／麦克风使用 Electron 合成设备，不连接 ZEGO 或
        IM。
      </p>
      <button onClick={() => qa.start("member")}>普通成员入会</button>
      <button onClick={() => qa.start("host")}>主持人入会</button>
      <button
        onClick={() => {
          qa.failNext = true;
        }}
      >
        下一次退会请求失败
      </button>
    </main>
    <MeetingRoomHost />
  </>,
);
