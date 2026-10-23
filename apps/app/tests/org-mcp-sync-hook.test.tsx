import * as React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("resume replaces deleted organization connectors quietly and recovers after a background failure", async () => {
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const host = Object.assign(new EventTarget(), {
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let rows: unknown[] = [{ id: "github", name: "GitHub" }];
  let fail = false;
  let release: (() => void) | undefined;
  let pause: Promise<void> | undefined;
  mock.module("../src/app/lib/den", () => ({
    readDenSettings: () => ({ baseUrl: "https://cloud.test", authToken: "test", activeOrgId: "org" }),
    createDenClient: () => ({
      listMcpConnections: async () => {
        await pause;
        if (fail) throw new Error("offline");
        return rows;
      },
    }),
  }));
  const { useOrgMcpConnections } = await import("../src/react-app/domains/connections/use-org-mcp-connections");
  let current: ReturnType<typeof useOrgMcpConnections> | undefined;
  function Probe() {
    current = useOrgMcpConnections();
    return null;
  }
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<Probe />); });
    expect(current!.connections.map((item) => item.id)).toEqual(["github"]);
    fail = true;
    await act(async () => { host.dispatchEvent(new Event("focus")); });
    expect(current!.error).toBeNull();
    expect(current!.connections).toHaveLength(1);
    fail = false;
    rows = [];
    pause = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => { host.dispatchEvent(new Event("online")); });
    expect(current!.loading).toBe(false);
    expect(current!.connections).toHaveLength(1);
    await act(async () => { release!(); });
    expect(current!.connections).toEqual([]);
    expect(current!.error).toBeNull();
  } finally {
    await act(async () => { view?.unmount(); });
    mock.restore();
    keys.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
