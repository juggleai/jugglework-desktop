import { afterEach, describe, expect, test } from "bun:test";

import {
  createDenClient,
  denCredentialFingerprint,
  DenApiError,
  isDenSessionRevokedError,
  mergePassiveDenSettings,
  readDenSettings,
  resolveDenAuthToken,
  writeDenSettings,
} from "../src/app/lib/den";
import { denSessionRevokedEvent } from "../src/app/lib/den-session-events";
import { resolveDenAuthFailureStatus } from "../src/react-app/domains/cloud/den-auth-provider";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalCustomEvent = globalThis.CustomEvent;

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

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: originalCustomEvent,
  });
});

describe("development Den credentials", () => {
  test("falls back to a newly persisted login after the fixed dev token is revoked", () => {
    const developmentToken = "tok_expired_dev";
    expect(resolveDenAuthToken({
      developmentToken,
      persistedToken: "tok_new_login",
      revokedDevelopmentFingerprint: null,
    })).toBe(developmentToken);
    expect(resolveDenAuthToken({
      developmentToken,
      persistedToken: "tok_new_login",
      revokedDevelopmentFingerprint: denCredentialFingerprint(developmentToken),
    })).toBe("tok_new_login");
    expect(resolveDenAuthToken({
      developmentToken: "tok_rotated_dev",
      persistedToken: "tok_new_login",
      revokedDevelopmentFingerprint: denCredentialFingerprint(developmentToken),
    })).toBe("tok_rotated_dev");
  });
});

describe("Den session revocation events", () => {
  test("broadcasts a confirmed authenticated 401 without exposing the token", async () => {
    const events: Array<{ type: string; detail?: unknown }> = [];
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class<T> {
        type: string;
        detail: T | undefined;
        constructor(type: string, init?: { detail?: T }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: (event: { type: string; detail?: unknown }) => {
          events.push(event);
          return true;
        },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => new Response(JSON.stringify({
        error: "unauthorized",
        message: "Session expired.",
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(createDenClient({
      baseUrl: "https://den.example.com",
      token: "tok_revoked_secret",
    }).getSession()).rejects.toBeInstanceOf(DenApiError);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(denSessionRevokedEvent);
    expect(events[0]?.detail).toEqual({
      authFingerprint: denCredentialFingerprint("tok_revoked_secret"),
      status: 401,
      code: "unauthorized",
      message: "Session expired.",
    });
    expect(JSON.stringify(events)).not.toContain("tok_revoked_secret");
  });

  test("does not revoke the session for an unclassified proxy 401", async () => {
    const events: unknown[] = [];
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class<T> {
        type: string;
        detail: T | undefined;
        constructor(type: string, init?: { detail?: T }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: (event: unknown) => {
          events.push(event);
          return true;
        },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => new Response("Unauthorized", { status: 401 }),
    });

    await expect(createDenClient({
      baseUrl: "https://den.example.com",
      token: "tok_keep",
    }).getSession()).rejects.toBeInstanceOf(DenApiError);
    expect(events).toHaveLength(0);
  });
});

describe("mergePassiveDenSettings", () => {
  test("preserves stored credentials and org when in-memory state is empty", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: "tok_stored",
        activeOrgId: "org_stored",
        activeOrgSlug: "stored-org",
        activeOrgName: "Stored Org",
      },
      {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
    );

    expect(result).toEqual({
      baseUrl: "https://next.example.com",
      apiBaseUrl: "https://next.example.com/jwork/api",
      authToken: "tok_stored",
      activeOrgId: "org_stored",
      activeOrgSlug: "stored-org",
      activeOrgName: "Stored Org",
    });
  });

  test("uses fresh in-memory values when they are present", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: "tok_stored",
        activeOrgId: "org_stored",
        activeOrgSlug: "stored-org",
        activeOrgName: "Stored Org",
      },
      {
        baseUrl: "https://next.example.com",
        authToken: " tok_fresh ",
        activeOrgId: " org_fresh ",
        activeOrgSlug: " fresh-org ",
        activeOrgName: " Fresh Org ",
      },
    );

    expect(result.authToken).toBe("tok_fresh");
    expect(result.activeOrgId).toBe("org_fresh");
    expect(result.activeOrgSlug).toBe("fresh-org");
    expect(result.activeOrgName).toBe("Fresh Org");
  });

  test("keeps empty storage empty when in-memory state is empty", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
      {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
    );

    expect(result.authToken).toBeNull();
    expect(result.activeOrgId).toBeNull();
    expect(result.activeOrgSlug).toBeNull();
    expect(result.activeOrgName).toBeNull();
  });

  test("passive write leaves stored session keys intact", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
      },
    });

    window.localStorage.setItem("jugglework.den.authToken", "tok_stored");
    window.localStorage.setItem("jugglework.den.activeOrgId", "org_stored");
    window.localStorage.setItem("jugglework.den.activeOrgSlug", "stored-org");
    window.localStorage.setItem("jugglework.den.activeOrgName", "Stored Org");

    writeDenSettings(
      mergePassiveDenSettings(readDenSettings(), {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      }),
    );

    expect(window.localStorage.getItem("jugglework.den.authToken")).toBe("tok_stored");
    expect(window.localStorage.getItem("jugglework.den.activeOrgId")).toBe("org_stored");
    expect(window.localStorage.getItem("jugglework.den.activeOrgSlug")).toBe("stored-org");
    expect(window.localStorage.getItem("jugglework.den.activeOrgName")).toBe("Stored Org");
  });
});

describe("isDenSessionRevokedError", () => {
  test("only treats Den-shaped 401s as revoked sessions", () => {
    expect(isDenSessionRevokedError(new DenApiError(401, "unauthorized", "Unauthorized"))).toBe(
      true,
    );
    expect(isDenSessionRevokedError(new DenApiError(401, "request_failed", "Proxy 401"))).toBe(
      false,
    );
    expect(isDenSessionRevokedError(new DenApiError(500, "server_error", "Server error"))).toBe(
      false,
    );
    expect(isDenSessionRevokedError(new Error("Request timed out."))).toBe(false);
  });
});

describe("resolveDenAuthFailureStatus", () => {
  test("keeps proxy-shaped 401s unavailable while Den-shaped 401s sign out", () => {
    expect(resolveDenAuthFailureStatus(new DenApiError(401, "request_failed", "Proxy 401"))).toBe(
      "unavailable",
    );
    expect(resolveDenAuthFailureStatus(new DenApiError(401, "unauthorized", "Unauthorized"))).toBe(
      "signed_out",
    );
    expect(resolveDenAuthFailureStatus(new Error("Request timed out."))).toBe("unavailable");
  });
});
