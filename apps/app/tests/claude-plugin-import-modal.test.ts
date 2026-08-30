import { describe, expect, test } from "bun:test";

import type { CloudImportedPluginFile } from "../src/app/cloud/import-state";
import type { CloudPluginMutationResult } from "../src/react-app/domains/settings/state/extensions-store";
import {
  isClaudePluginImportComplete,
  resolveClaudePluginImportFeedback,
} from "../src/react-app/domains/connections/modals/claude-plugin-import-modal";

const installedFile: CloudImportedPluginFile = {
  configObjectId: "skill-1",
  versionId: null,
  objectType: "skill",
  title: "Example skill",
  path: ".opencode/skills/example/SKILL.md",
  updatedAt: null,
  outcome: "installed_local",
};

function result(overrides: Partial<CloudPluginMutationResult> = {}): CloudPluginMutationResult {
  return {
    ok: true,
    message: "Installed Example.",
    warnings: [],
    status: "installed",
    conflicts: [],
    outcomes: [installedFile],
    files: [installedFile],
    ...overrides,
  };
}

describe("Claude plugin import result UX", () => {
  test("closes only for a clean installed result", () => {
    expect(isClaudePluginImportComplete(result())).toBeTrue();

    for (const status of ["partial", "failed", "repair_required"] as const) {
      expect(isClaudePluginImportComplete(result({ status }))).toBeFalse();
    }
    expect(isClaudePluginImportComplete(result({ ok: false }))).toBeFalse();
    expect(isClaudePluginImportComplete(result({ warnings: ["Skipped one component."] }))).toBeFalse();
    expect(isClaudePluginImportComplete(result({
      conflicts: [{
        code: "file_ownership_conflict",
        configObjectId: "skill-1",
        resource: installedFile.path,
        message: "The file is owned by another plugin.",
      }],
    }))).toBeFalse();
  });

  test("keeps sign-in and administrator setup outcomes actionable", () => {
    for (const outcome of ["needs_signin", "needs_admin_setup"] as const) {
      const blockedFile = { ...installedFile, outcome };
      const installResult = result({ outcomes: [blockedFile], files: [blockedFile] });
      expect(isClaudePluginImportComplete(installResult)).toBeFalse();

      const feedback = resolveClaudePluginImportFeedback(installResult);
      expect(feedback?.details.join(" ")).toContain(blockedFile.title);
      expect(feedback?.details.join(" ")).toContain(
        outcome === "needs_signin" ? "Sign in" : "organization administrator",
      );
    }
  });

  test("surfaces partial failures, repair instructions, conflicts, and warnings", () => {
    const partial = resolveClaudePluginImportFeedback(result({
      status: "partial",
      warnings: ["One optional command was skipped."],
      outcomes: [{ ...installedFile, outcome: "failed", errorMessage: "Invalid command metadata." }],
    }));
    expect(partial?.tone).toBe("warning");
    expect(partial?.title).toContain("partially");
    expect(partial?.details).toContain("One optional command was skipped.");
    expect(partial?.details.join(" ")).toContain("Invalid command metadata");

    const repair = resolveClaudePluginImportFeedback(result({
      ok: false,
      status: "repair_required",
      message: "Repair workspace resources before retrying.",
    }));
    expect(repair).toEqual(expect.objectContaining({ tone: "error", title: "Repair required" }));

    const conflict = resolveClaudePluginImportFeedback(result({
      conflicts: [{
        code: "file_ownership_conflict",
        configObjectId: "skill-1",
        resource: installedFile.path,
        message: "Resolve file ownership before retrying.",
      }],
    }));
    expect(conflict?.title).toContain("conflicts");
    expect(conflict?.details).toContain("Resolve file ownership before retrying.");
  });
});
