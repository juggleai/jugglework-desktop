import { describe, expect, test } from "bun:test";
import { parseAutomationPrompt, readAutomationSkillIds, serializeAutomationPrompt } from "../src/react-app/domains/automations/automation-prompt-template";

describe("automation durable prompt template", () => {
  test("preserves text, workspace-relative files, and stable skills across reopen", () => {
    const source = "Summarize the input\n@file:docs/report.md\n[skill weekly-report]\nKeep it concise";
    const parsed = parseAutomationPrompt(source);
    expect(parsed.parts).toEqual([
      { type: "text", text: "Summarize the input" },
      { type: "file", relativePath: "docs/report.md" },
      { type: "skill", skillId: "weekly-report" },
      { type: "text", text: "Keep it concise" },
    ]);
    expect(serializeAutomationPrompt(parsed)).toBe(source);
  });

  test("still accepts the legacy whole-line skill reference", () => {
    expect(parseAutomationPrompt("$skill:weekly-report\nGo").parts).toEqual([
      { type: "skill", skillId: "weekly-report" },
      { type: "text", text: "Go" },
    ]);
  });

  test("reads inline skill tags mixed into a line and de-duplicates them", () => {
    const parsed = parseAutomationPrompt("Use [skill prd-writer] then [skill prd-writer] again");
    expect(parsed.parts).toEqual([
      { type: "text", text: "Use" },
      { type: "skill", skillId: "prd-writer" },
      { type: "text", text: "then" },
      { type: "skill", skillId: "prd-writer" },
      { type: "text", text: "again" },
    ]);
    expect(readAutomationSkillIds("Use [skill prd-writer] then [skill prd-writer] again")).toEqual(["prd-writer"]);
  });

  test("rejects ephemeral parts and external file paths", () => {
    expect(() => parseAutomationPrompt("[attachment] clipboard image")).toThrow(/不支持临时附件/);
    expect(() => parseAutomationPrompt("@file:/Users/private/secret.txt")).toThrow(/相对路径/);
    expect(() => parseAutomationPrompt("@file:../secret.txt")).toThrow(/相对路径/);
  });
});
