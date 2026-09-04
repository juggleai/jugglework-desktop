import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGithubEventAuthFromEnv } from "./github-event-auth.js";

const ENV_KEYS = ["JUGGLEWORK_GITHUB_EVENT_BASE_URL", "JUGGLEWORK_GITHUB_EVENT_TOKEN"] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("returns null when either baseUrl or token is missing", () => {
  withEnv({}, () => assert.equal(resolveGithubEventAuthFromEnv(), null));
  withEnv({ JUGGLEWORK_GITHUB_EVENT_BASE_URL: "https://cloud.example.com" }, () => assert.equal(resolveGithubEventAuthFromEnv(), null));
  withEnv({ JUGGLEWORK_GITHUB_EVENT_TOKEN: "tok" }, () => assert.equal(resolveGithubEventAuthFromEnv(), null));
});

test("returns baseUrl+token when both are set", () => {
  withEnv({ JUGGLEWORK_GITHUB_EVENT_BASE_URL: "https://cloud.example.com", JUGGLEWORK_GITHUB_EVENT_TOKEN: "tok" }, () => {
    assert.deepEqual(resolveGithubEventAuthFromEnv(), { baseUrl: "https://cloud.example.com", token: "tok" });
  });
});

test("blank/whitespace-only values are treated the same as unset", () => {
  withEnv({ JUGGLEWORK_GITHUB_EVENT_BASE_URL: "   ", JUGGLEWORK_GITHUB_EVENT_TOKEN: "tok" }, () => {
    assert.equal(resolveGithubEventAuthFromEnv(), null);
  });
});
