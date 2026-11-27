import { describe, expect, test } from "bun:test";
import { createWorkspaceEngineWarmup, type WarmFetch } from "./workspace-engine-warmup.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const config = {} as ServerConfig;
const local: WorkspaceInfo = { id: "ws_a", name: "A", path: "/tmp/a", preset: "starter", workspaceType: "local" };
const other: WorkspaceInfo = { id: "ws_b", name: "B", path: "/tmp/b", preset: "starter", workspaceType: "local" };
const remote: WorkspaceInfo = { id: "ws_r", name: "R", path: "/tmp/r", preset: "starter", workspaceType: "remote" };

function target(workspace: WorkspaceInfo) {
  if (workspace.workspaceType !== "local") return null;
  return { baseUrl: "http://127.0.0.1:4096", directory: workspace.path, headers: { Authorization: "Basic fixture" } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace engine warmup", () => {
  test("requests only the read-only config endpoint for the workspace directory", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: WarmFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, body: null };
    };
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w) });

    expect(await warmup.warm(config, local)).toBe("warmed");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/config");
    expect(url.searchParams.get("directory")).toBe("/tmp/a");
    expect(calls[0]!.headers.Authorization).toBe("Basic fixture");
  });

  test("concurrent warmups of one directory share a single request", async () => {
    const gate = deferred<{ ok: boolean }>();
    let requests = 0;
    const fetchImpl: WarmFetch = async () => { requests += 1; return gate.promise; };
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w) });

    const first = warmup.warm(config, local);
    const second = warmup.warm(config, local);
    gate.resolve({ ok: true });

    expect(await Promise.all([first, second])).toEqual(["warmed", "warmed"]);
    expect(requests).toBe(1);
  });

  test("does not repeat inside the cooldown, and repeats after it or after forget()", async () => {
    let clock = 1_000;
    let requests = 0;
    const fetchImpl: WarmFetch = async () => { requests += 1; return { ok: true }; };
    const warmup = createWorkspaceEngineWarmup({
      fetchImpl, resolveTarget: (_c, w) => target(w), now: () => clock, cooldownMs: 60_000,
    });

    expect(await warmup.warm(config, local)).toBe("warmed");
    clock += 10_000;
    expect(await warmup.warm(config, local)).toBe("skipped");
    expect(requests).toBe(1);

    // 引擎 dispose 之后实例要重建，之前的预热不再有效。
    warmup.forget(config, local);
    expect(await warmup.warm(config, local)).toBe("warmed");
    expect(requests).toBe(2);

    clock += 61_000;
    expect(await warmup.warm(config, local)).toBe("warmed");
    expect(requests).toBe(3);
  });

  test("warms only the requested workspace and never touches other directories", async () => {
    const directories: string[] = [];
    const fetchImpl: WarmFetch = async (url) => {
      directories.push(new URL(url).searchParams.get("directory") ?? "");
      return { ok: true };
    };
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w) });

    await warmup.warm(config, local);
    expect(directories).toEqual(["/tmp/a"]);
    await warmup.warm(config, other);
    expect(directories).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("skips workspaces with no warmable target", async () => {
    let requests = 0;
    const fetchImpl: WarmFetch = async () => { requests += 1; return { ok: true }; };
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w) });

    expect(await warmup.warm(config, remote)).toBe("skipped");
    expect(requests).toBe(0);
  });

  test("never throws: a failing engine or a throwing resolver is reported, not raised", async () => {
    const failing = createWorkspaceEngineWarmup({
      fetchImpl: async () => { throw new Error("connection refused"); },
      resolveTarget: (_c, w) => target(w),
    });
    expect(await failing.warm(config, local)).toBe("failed");

    const notOk = createWorkspaceEngineWarmup({
      fetchImpl: async () => ({ ok: false }),
      resolveTarget: (_c, w) => target(w),
    });
    expect(await notOk.warm(config, local)).toBe("failed");

    const throwing = createWorkspaceEngineWarmup({
      fetchImpl: async () => ({ ok: true }),
      resolveTarget: () => { throw new Error("bad config"); },
    });
    expect(await throwing.warm(config, local)).toBe("skipped");
  });

  test("a failed warmup is retried by the next call instead of being cached as success", async () => {
    let requests = 0;
    const fetchImpl: WarmFetch = async () => {
      requests += 1;
      if (requests === 1) throw new Error("engine still starting");
      return { ok: true };
    };
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w) });

    expect(await warmup.warm(config, local)).toBe("failed");
    expect(await warmup.warm(config, local)).toBe("warmed");
    expect(requests).toBe(2);
  });

  test("a hung engine is bounded by the timeout signal", async () => {
    let aborted = false;
    const fetchImpl: WarmFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    });
    const warmup = createWorkspaceEngineWarmup({ fetchImpl, resolveTarget: (_c, w) => target(w), timeoutMs: 20 });

    expect(await warmup.warm(config, local)).toBe("failed");
    expect(aborted).toBe(true);
  });
});
