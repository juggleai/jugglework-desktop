import { afterEach, expect, test } from "bun:test";

import { buildDenAuthUrl, resolveDesktopAuthScheme } from "../src/app/lib/den";

const ENV_KEY = "VITE_JUGGLEWORK_DESKTOP_AUTH_SCHEME";
const baseUrl = "https://work.juggle.im/jwork";

afterEach(() => {
  delete process.env[ENV_KEY];
});

test("defaults the desktop auth callback scheme to jugglework", () => {
  expect(resolveDesktopAuthScheme(undefined)).toBe("jugglework");
  expect(resolveDesktopAuthScheme("   ")).toBe("jugglework");
});

test("accepts an isolated development callback scheme", () => {
  expect(resolveDesktopAuthScheme("jugglework-dev")).toBe("jugglework-dev");
});

test("rejects malformed schemes and falls back to jugglework", () => {
  expect(resolveDesktopAuthScheme("jugglework://evil")).toBe("jugglework");
  expect(resolveDesktopAuthScheme("1bad")).toBe("jugglework");
  expect(resolveDesktopAuthScheme("https")).toBe("jugglework");
});

test("sign-in URL uses the configured development scheme", () => {
  process.env[ENV_KEY] = "jugglework-dev";
  const url = new URL(buildDenAuthUrl(baseUrl, "sign-in"));
  expect(url.searchParams.get("desktopScheme")).toBe("jugglework-dev");
});

test("sign-in URL keeps jugglework when no scheme is configured", () => {
  const url = new URL(buildDenAuthUrl(baseUrl, "sign-in"));
  expect(url.searchParams.get("desktopScheme")).toBe("jugglework");
});
