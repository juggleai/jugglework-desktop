import React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("shared disconnect requires the explicit management action and refreshes after removal", async () => {
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const host = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval() {} });
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let rows = [{ id: "github", credentialMode: "shared", connected: true, connectedForMe: true }];
  const disconnect = mock(async (_org: string, _id: string) => { rows = rows.map((entry) => ({ ...entry, connected: false, connectedForMe: false })); });
  mock.module("../src/app/lib/den", () => ({
    readDenSettings: () => ({ baseUrl: "https://cloud.test", authToken: "token", activeOrgId: "org" }),
    createDenClient: () => ({ listMcpConnections: async () => rows, disconnectMcpConnection: disconnect }),
  }));
  const { useOrgMcpConnections } = await import("../src/react-app/domains/connections/use-org-mcp-connections");
  let current: ReturnType<typeof useOrgMcpConnections>;
  function Probe() { current = useOrgMcpConnections(); return null; }
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<Probe />); });
    await act(async () => { await current!.disconnect("github"); });
    expect(disconnect).not.toHaveBeenCalled();
    await act(async () => { await current!.disconnect("github", { allowShared: true }); });
    expect(disconnect).toHaveBeenCalledWith("org", "github");
    expect(current!.connections[0]!.connected).toBe(false);
    expect(current!.disconnectingId).toBeNull();
    rows = [{ id: "personal-github", credentialMode: "per_member", connected: true, connectedForMe: true }];
    await act(async () => { await current!.refresh(); });
    await act(async () => { await current!.disconnect("personal-github"); });
    expect(disconnect).toHaveBeenCalledWith("org", "personal-github");
  } finally {
    await act(async () => { view?.unmount(); });
    mock.restore();
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
