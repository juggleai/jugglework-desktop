import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearDenSession,
  CLOUD_MCP_SYNC_MARKER_STORAGE_KEY,
  ensureDenActiveOrganization,
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenIMLoginBootstrap,
  readDenSettings,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";

const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("desktop Den bootstrap settings", () => {
  let bootstrapConfig: {
    baseUrl: string;
    requireSignin: boolean;
    fromFile?: boolean;
    writtenAt?: string;
    claimLinks?: Array<{ id: string; role: string; url: string; expiresAt: string }>;
    prepared?: {
      orgId: string;
      orgName: string;
      orgSlug: string;
      skillId: string;
      skillTitle: string;
      skillsDir: string;
      skillPath: string;
      preparedAt: string;
    };
  };

  beforeEach(() => {
    bootstrapConfig = {
      baseUrl: "https://bootstrap.example.com",
      requireSignin: false,
    };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __JUGGLEWORK_ELECTRON__: {
          invokeDesktop: async (command: string, ...args: unknown[]) => {
            const payload = args[0] as { baseUrl: string; requireSignin: boolean } | undefined;
            if (command === "getDesktopBootstrapConfig") return bootstrapConfig;
            if (command === "setDesktopBootstrapConfig" && payload) {
              bootstrapConfig = {
                baseUrl: payload.baseUrl,
                requireSignin: payload.requireSignin,
                writtenAt: "2026-07-08T00:00:00.000Z",
              };
              return bootstrapConfig;
            }
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("reads the desktop base URL from bootstrap instead of stale localStorage", async () => {
    window.localStorage.setItem("jugglework.den.baseUrl", "https://stale.example.com");
    window.localStorage.setItem("jugglework.den.apiBaseUrl", "https://api.example.com");

    await initializeDenBootstrapConfig();

    const settings = readDenSettings();
    expect(settings.baseUrl).toBe("https://bootstrap.example.com");
    expect(settings.apiBaseUrl).toBe("https://bootstrap.example.com/jwork/api");
  });

  test("keeps the prepared workspace and claim action in the shared bootstrap snapshot", async () => {
    bootstrapConfig.claimLinks = [{
      id: "claim_owner",
      role: "owner",
      url: "https://bootstrap.example.com/workspace-claim?token=secret",
      expiresAt: "2026-07-15T00:00:00.000Z",
    }];
    bootstrapConfig.prepared = {
      orgId: "org_demo",
      orgName: "Different AI",
      orgSlug: "juggleai",
      skillId: "skill_demo",
      skillTitle: "Customer Briefing",
      skillsDir: "/tmp/skills",
      skillPath: "/tmp/skills/customer-briefing/SKILL.md",
      preparedAt: "2026-07-14T00:00:00.000Z",
    };

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().prepared?.orgName).toBe("Different AI");
    expect(readDenBootstrapConfig().claimLinks?.[0]?.role).toBe("owner");
  });

  test("threads desktop bootstrap file origin into the shared bootstrap snapshot", async () => {
    bootstrapConfig.fromFile = true;

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().source).toBe("file");
  });

  test("uses preload desktop bootstrap before async desktop IPC", async () => {
    let ipcReads = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __JUGGLEWORK_ELECTRON__: {
          meta: {
            desktopBootstrap: {
              baseUrl: "https://preload.example.com",
              requireSignin: true,
              fromFile: true,
            },
          },
          invokeDesktop: async (command: string) => {
            if (command === "getDesktopBootstrapConfig") ipcReads += 1;
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().baseUrl).toBe("https://preload.example.com");
    expect(readDenBootstrapConfig().source).toBe("file");
    expect(ipcReads).toBe(0);
  });

  test("saves base URL changes to bootstrap and clears legacy endpoint storage", async () => {
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("jugglework.den.baseUrl", "https://stale.example.com");
    window.localStorage.setItem("jugglework.den.apiBaseUrl", "https://api.example.com");

    await setDenBootstrapConfig({
      baseUrl: "https://saved.example.com",
      requireSignin: false,
    });
    writeDenSettings({
      baseUrl: "https://saved.example.com",
      authToken: "tok_test",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    });

    expect(bootstrapConfig.baseUrl).toBe("https://saved.example.com");
    expect(window.localStorage.getItem("jugglework.den.baseUrl")).toBeNull();
    expect(window.localStorage.getItem("jugglework.den.apiBaseUrl")).toBeNull();
    expect(readDenSettings().baseUrl).toBe("https://saved.example.com");
  });

  test("session or server changes invalidate configured Cloud MCP token markers", async () => {
    await initializeDenBootstrapConfig();
    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");

    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "first-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "next-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    writeDenSettings({
      baseUrl: "https://next.example.com",
      authToken: "next-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    clearDenSession();
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();
  });

  test("reprovisions missing IM credentials even when the active organization already matches", async () => {
    await initializeDenBootstrapConfig();
    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "current-session",
      activeOrgId: "org_team",
      activeOrgSlug: "team",
      activeOrgName: "Team",
    });
    const requests: Array<{ url: string; method: string }> = [];
    window.__JUGGLEWORK_ELECTRON__!.invokeDesktop = async (command: string, ...args: unknown[]) => {
      if (command === "getDesktopBootstrapConfig") return bootstrapConfig;
      if (command === "__fetch") {
        const url = String(args[0]);
        const init = (args[1] ?? {}) as RequestInit;
        const method = init.method ?? "GET";
        requests.push({ url, method });
        if (url.endsWith("/v1/me/orgs")) {
          return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify({
            orgs: [{ id: "org_team", name: "Team", slug: "team", role: "member", kind: "organization" }],
            activeOrgId: "org_team",
            activeOrgSlug: "team",
          }) };
        }
        if (url.endsWith("/v1/me/active-organization") && method === "POST") {
          return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify({
            activeOrgId: "org_team",
            activeOrgSlug: "team",
            im: {
              provider: "juggleim",
              websocketUrl: "wss://im.example.com",
              appKey: "app-key",
              imUserId: "im-user",
              token: "im-session",
            },
          }) };
        }
        return { status: 404, statusText: "Not Found", headers: {}, body: "not found" };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    };

    await ensureDenActiveOrganization({ forceServerSync: true });

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/jwork/api/v1/me/orgs"],
      ["POST", "/jwork/api/v1/me/active-organization"],
    ]);
    expect(readDenIMLoginBootstrap()).toMatchObject({
      provider: "juggleim",
      imUserId: "im-user",
    });
  });

  test("does not repeatedly request IM credentials for a personal workspace", async () => {
    await initializeDenBootstrapConfig();
    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "current-session",
      activeOrgId: "org_personal",
      activeOrgSlug: "personal",
      activeOrgName: "Personal",
    });
    const methods: string[] = [];
    window.__JUGGLEWORK_ELECTRON__!.invokeDesktop = async (command: string, ...args: unknown[]) => {
      if (command === "getDesktopBootstrapConfig") return bootstrapConfig;
      if (command === "__fetch") {
        const init = (args[1] ?? {}) as RequestInit;
        methods.push(init.method ?? "GET");
        return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify({
          orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal" }],
          activeOrgId: "org_personal",
          activeOrgSlug: "personal",
        }) };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    };

    await ensureDenActiveOrganization({ forceServerSync: true });

    expect(methods).toEqual(["GET"]);
    expect(readDenIMLoginBootstrap()).toBeNull();
  });
});
