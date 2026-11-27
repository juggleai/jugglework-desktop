import { describe, expect, test } from "bun:test";
import { ManagedProviderAuthorityStore, type ManagedProviderScope } from "./managed-provider-authority.js";

const scope: ManagedProviderScope = { deployment: "https://cloud.example.test/jwork/api", userId: "user", organizationId: "org", session: "a".repeat(64) };

// 模拟一次进程启动：启动流程先围栏取得 revision，再确认身份。
function bootAndConfirm(next: ManagedProviderScope = scope) {
  const store = new ManagedProviderAuthorityStore();
  const authority = store.confirm(store.fence(), next);
  expect(authority).not.toBeNull();
  return authority!.id;
}

describe("managed provider authority id", () => {
  test("is stable across process restarts for the same confirmed identity", () => {
    expect(bootAndConfirm()).toBe(bootAndConfirm());
  });

  test("changes when user, organization, deployment or session changes", () => {
    const base = bootAndConfirm();
    for (const change of [{ userId: "other" }, { organizationId: "other-org" }, { deployment: "https://other.example.test/api" }, { session: "b".repeat(64) }]) {
      expect(bootAndConfirm({ ...scope, ...change })).not.toBe(base);
    }
  });

  test("a fence inside one process retires the old id even for the same identity", () => {
    const store = new ManagedProviderAuthorityStore();
    const first = store.confirm(store.fence(), scope)!.id;
    const second = store.confirm(store.fence(), scope)!.id;
    expect(second).not.toBe(first);
    expect(store.setWorkspaceReady(first, "ws", true)).toBe(false);
    expect(store.setWorkspaceReady(second, "ws", true)).toBe(true);
  });

  test("re-confirming the same identity keeps the current id and readiness", () => {
    const store = new ManagedProviderAuthorityStore();
    const first = store.confirm(store.fence(), scope)!;
    expect(store.setWorkspaceReady(first.id, "ws", true)).toBe(true);
    const again = store.confirm(store.currentRevision(), scope)!;
    expect(again.id).toBe(first.id);
    expect(store.forWorkspace("ws")?.id).toBe(first.id);
  });

  test("a stale revision cannot confirm", () => {
    const store = new ManagedProviderAuthorityStore();
    const stale = store.fence();
    store.fence();
    expect(store.confirm(stale, scope)).toBeNull();
  });

  test("the id does not expose the raw session digest", () => {
    expect(bootAndConfirm()).not.toContain("a".repeat(16));
  });
});
