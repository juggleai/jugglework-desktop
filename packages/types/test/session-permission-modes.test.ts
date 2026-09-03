import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  matchesSessionPermissionResource,
  sessionPermissionGrantCoversResources,
} from "../src/session-permission-modes.ts"

describe("matchesSessionPermissionResource", () => {
  test("exact literals match", () => {
    assert.equal(matchesSessionPermissionResource("/tmp/a.txt", "/tmp/a.txt"), true)
    assert.equal(matchesSessionPermissionResource("/tmp/a.txt", "/tmp/b.txt"), false)
  })

  test("star matches zero or more characters", () => {
    assert.equal(matchesSessionPermissionResource("/tmp/*", "/tmp/"), true)
    assert.equal(matchesSessionPermissionResource("/tmp/*", "/tmp/deep/nested/file"), true)
    assert.equal(matchesSessionPermissionResource("/tmp/*", "/etc/passwd"), false)
  })

  test("matching is case-sensitive and full-string", () => {
    assert.equal(matchesSessionPermissionResource("/TMP/*", "/tmp/a"), false)
    assert.equal(matchesSessionPermissionResource("bash", "bash git push"), false)
  })

  test("regex metacharacters are literal", () => {
    assert.equal(matchesSessionPermissionResource("a.b*c+d", "a.b*c+d"), true)
    assert.equal(matchesSessionPermissionResource("a.b*c+d", "aXbYcZd"), false)
  })

  test("empty patterns or resources never match", () => {
    assert.equal(matchesSessionPermissionResource("", "x"), false)
    assert.equal(matchesSessionPermissionResource("*", ""), false)
  })
})

const grantBase = {
  protocol: "legacy" as const,
  permissionAction: "bash",
  resources: ["git push *"],
}

describe("sessionPermissionGrantCoversResources", () => {
  test("complete coverage approves; partial coverage does not", () => {
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push origin main"],
    }), true)
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push origin main", "rm -rf /"],
    }), false)
  })

  test("cross-protocol and cross-action never match", () => {
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "v2",
      permissionAction: "bash",
      resources: ["git push origin main"],
    }), false)
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "legacy",
      permissionAction: "edit",
      resources: ["git push origin main"],
    }), false)
  })

  test("duplicates are removed without changing meaning", () => {
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push origin main", "git push origin main"],
    }), true)
  })

  test("empty or malformed input fails closed", () => {
    assert.equal(sessionPermissionGrantCoversResources(
      { ...grantBase, resources: [] },
      { protocol: "legacy", permissionAction: "bash", resources: ["x"] },
    ), false)
    assert.equal(sessionPermissionGrantCoversResources(grantBase, {
      protocol: "legacy",
      permissionAction: "bash",
      resources: [],
    }), false)
  })
})
