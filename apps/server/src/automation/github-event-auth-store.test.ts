import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubEventAuthStore } from "./github-event-auth-store.js";

test("returns null until something is pushed, then returns exactly what was pushed", () => {
  const store = new GithubEventAuthStore();
  assert.equal(store.get(), null);
  store.set({ baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent" });
  assert.deepEqual(store.get(), { baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent" });
});

test("can be cleared back to null (renderer sign-out)", () => {
  const store = new GithubEventAuthStore();
  store.set({ baseUrl: "https://cloud.example.com", token: "tok" });
  store.set(null);
  assert.equal(store.get(), null);
});
