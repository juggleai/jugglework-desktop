import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingPermission } from "../src/app/types";

import {
  PermissionApprovalPanel,
  permissionDetailRows,
} from "../src/react-app/domains/session/chat/permission-approval-modal";

function pendingPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "permission-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["rm -rf dist"],
    metadata: {},
    // Legacy runtime 提供的可复用授权范围（always patterns）。
    always: ["rm -rf dist"],
    receivedAt: 1,
    interactionRevision: 1,
    protocol: "legacy",
    targetSessionId: "session-1",
    parentSessionId: null,
    rootSessionId: "session-1",
    ancestryPath: ["session-1"],
    ...overrides,
  };
}

describe("permission approval modal helpers", () => {
  test("surfaces risk-bearing metadata as review rows", () => {
    expect(
      permissionDetailRows({
        command: "rm -rf dist",
        description: "Remove build output",
        cwd: "/workspace/project",
        filepath: "/workspace/project/src/app.ts",
        diff: "-old\n+new",
        output: "not shown before approval",
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Command", "rm -rf dist"],
      ["Description", "Remove build output"],
      ["Working directory", "/workspace/project"],
      ["File", "/workspace/project/src/app.ts"],
      ["Diff", "-old\n+new"],
    ]);
  });

  test("deduplicates alternate file metadata keys", () => {
    expect(
      permissionDetailRows({
        filepath: "/workspace/project/a.ts",
        filePath: "/workspace/project/b.ts",
      }).map((row) => [row.label, row.value]),
    ).toEqual([["File", "/workspace/project/a.ts"]]);
  });

  test("summarizes apply-patch file metadata", () => {
    expect(
      permissionDetailRows({
        files: [
          { type: "add", relativePath: "src/new.ts" },
          { type: "delete", filePath: "/workspace/project/src/old.ts" },
          { type: "", path: "src/update.ts" },
        ],
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Files", "add: src/new.ts\ndelete: /workspace/project/src/old.ts\nchange: src/update.ts"],
    ]);
  });

  test("keeps keyboard order on the safer one-shot approval before session approval", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission(),
        respondPermission: () => {},
        respondPermissionGrant: () => {},
      }),
    );

    const buttonLabels = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) =>
      match[0].replace(/<[^>]*>/g, "").trim(),
    );

    expect(buttonLabels).toEqual(["Deny", "Allow once", "Always allow in this session"]);
  });

  test("hides the session grant action when no grant responder is wired", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission(),
        respondPermission: () => {},
      }),
    );

    expect(html).not.toContain("Always allow in this session");
  });

  test("hides the session grant action when the runtime offers no reusable scope", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({ always: [] }),
        respondPermission: () => {},
        respondPermissionGrant: () => {},
      }),
    );

    expect(html).not.toContain("Always allow in this session");
  });

  test("uses readable labels for generic permission titles", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({ permission: "todowrite" }),
        respondPermission: () => {},
      }),
    );

    expect(html).toContain("Approve Todo write?");
    expect(html).not.toContain("Approve todowrite?");
  });

  test("identifies descendant approvals as subagent requests", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({
          sessionID: "child-session",
          targetSessionId: "child-session",
          parentSessionId: "root-session",
          rootSessionId: "root-session",
        }),
      }),
    );

    expect(html).toContain("Subagent request");
  });
});
