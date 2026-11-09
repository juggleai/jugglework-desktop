import { expect, mock, test } from "bun:test";

let infoReads = 0;
let healthReads = 0;
let capabilityReads = 0;

mock.module("../src/app/lib/desktop", () => ({
  juggleworkServerInfo: async () => {
    infoReads += 1;
    if (infoReads === 1) throw new Error("local server is still starting");
    return {
      running: true,
      baseUrl: "http://127.0.0.1:43123",
      clientToken: "live-client-token",
      hostToken: "live-host-token",
      remoteAccessEnabled: false,
    };
  },
  juggleworkServerRestart: async () => { throw new Error("restart should not be needed"); },
}));

mock.module("../src/app/lib/jugglework-server", () => ({
  clearJuggleWorkServerSettings() {},
  createJuggleWorkServerClient: (options: { baseUrl: string }) => ({
    baseUrl: options.baseUrl,
    health: async () => { healthReads += 1; return { ok: true }; },
    capabilities: async () => { capabilityReads += 1; return {}; },
  }),
  isLoopbackJuggleWorkServerUrl: (value: string) => value.startsWith("http://127.0.0.1:"),
  normalizeJuggleWorkServerUrl: (value: string) => value.trim() || null,
  readJuggleWorkServerSettings: () => ({}),
  writeJuggleWorkServerSettings: (value: unknown) => value,
}));

const { createJuggleWorkServerStore } = await import("../src/react-app/domains/connections/jugglework-server-store");

test("rechecks health when local host info appears after the first probe", async () => {
  const previousWindow = globalThis.window;
  const timeouts = new Map<number, { callback: () => void; delay: number }>();
  const intervals = new Map<number, () => void>();
  let timerId = 0;
  const fakeWindow = {
    __JUGGLEWORK_ELECTRON__: {},
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++timerId;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => { timeouts.delete(id); },
    setInterval: (callback: () => void) => {
      const id = ++timerId;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => { intervals.delete(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const runNextTimeout = async () => {
    const next = [...timeouts.entries()].sort((left, right) => left[1].delay - right[1].delay || left[0] - right[0])[0];
    expect(next).toBeDefined();
    timeouts.delete(next![0]);
    next![1].callback();
    await flush();
  };

  infoReads = 0;
  healthReads = 0;
  capabilityReads = 0;
  const store = createJuggleWorkServerStore({
    startupPreference: () => "local",
    documentVisible: () => true,
    developerMode: () => false,
    runtimeWorkspaceId: () => null,
    activeClient: () => null,
    selectedWorkspaceDisplay: () => ({
      id: "",
      name: "",
      path: "",
      preset: "starter",
      workspaceType: "local",
    }),
    restartLocalServer: async () => false,
    createRemoteWorkspaceFlow: async () => false,
  });

  try {
    store.start();
    await flush();
    await runNextTimeout();

    expect(infoReads).toBe(1);
    expect(store.getSnapshot().juggleworkServerStatus).toBe("disconnected");
    expect(store.getSnapshot().juggleworkServerReady).toBe(false);
    expect(store.getSnapshot().juggleworkServerCheckedAt).toBeNull();
    expect(timeouts.size).toBe(2);

    await runNextTimeout();

    expect(infoReads).toBe(2);
    expect(timeouts.size).toBe(1);
    await runNextTimeout();

    expect(healthReads).toBe(1);
    expect(capabilityReads).toBe(1);
    expect(store.getSnapshot().juggleworkServerStatus).toBe("connected");
    expect(store.getSnapshot().juggleworkServerReady).toBe(true);
    expect(store.getSnapshot().juggleworkServerClient?.baseUrl).toBe("http://127.0.0.1:43123");
  } finally {
    store.dispose();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
