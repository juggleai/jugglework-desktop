/** @jsxImportSource react */
import { expect, test } from "bun:test";
import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { MainOfficeComposerBridge } from "../src/react-app/domains/session/surface/composer/office-composer-bridge";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import type { OfficeSelectionReference } from "@jugglework/types/office";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("登录和设置路由响应共享文件关闭检查，路由变化不清理旧确认且仍保护未发送选区", async () => {
  const previousWindow = globalThis.window;
  let request: ((input: any) => Promise<any>) | undefined;
  let navigate: ReturnType<typeof useNavigate>;
  let root: TestRenderer.ReactTestRenderer | undefined;
  function Navigation() { navigate = useNavigate(); return null; }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __JUGGLEWORK_ELECTRON__: { office: {
    onComposerRequest(handler: typeof request) { request = handler; return () => { request = undefined; }; },
  } } } });
  try {
    await act(async () => { root = TestRenderer.create(<MemoryRouter initialEntries={["/signin"]}><MainOfficeComposerBridge /><Navigation /></MemoryRouter>); });
    const input = { workspaceId: "ws", sessionId: "chat", closingDocumentId: "doc" };
    expect(await request!({ ...input, action: "guard" })).toMatchObject({ scope: "/signin", referenceIds: [], needsConfirmation: false });
    const reference = { referenceId: "r", workspaceId: "ws", ownerSessionId: "chat", documentId: "doc", preview: { path: "file.docx" } } as OfficeSelectionReference;
    useComposerStateStore.getState().appendOfficeSelection({ workspaceId: "ws", sessionId: "chat", instructionId: "i", reference, epoch: 0, text: "保留这段要求", mode: "add" });
    const guard = await request!({ ...input, action: "guard" });
    expect(guard).toMatchObject({ referenceIds: ["r"], needsConfirmation: true });
    await act(async () => { await navigate!("/settings"); });
    expect(await request!({ ...input, ...guard, action: "clear" })).toMatchObject({ ok: false });
    expect(await request!({ ...input, action: "guard" })).toMatchObject({ scope: "/settings", referenceIds: ["r"], needsConfirmation: true });
    await act(async () => { root!.unmount(); root = undefined; });
    expect(request).toBeUndefined();
  } finally {
    if (root) await act(async () => root!.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, officeEpochs: {} });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
