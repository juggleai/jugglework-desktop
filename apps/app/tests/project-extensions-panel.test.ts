import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const panel = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/project-extensions-panel.tsx", import.meta.url), "utf8");
const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");

describe("session project settings panel", () => {
  test("uses the concise Settings title", () => {
    expect(zh).toMatch(/"project_extensions\.panel_title": "设置"/);
  });

  test("only shows instructions, connectors and skills", () => {
    expect(panel).toMatch(/project_extensions\.group_instruction/);
    expect(panel).toMatch(/project_extensions\.group_connector/);
    expect(panel).toMatch(/project_extensions\.group_skill/);
    expect(panel).not.toMatch(/project_extensions\.group_expert/);
    expect(panel).not.toMatch(/project_extensions\.group_automation/);
  });

  test("does not render a skill avatar preview row", () => {
    expect(panel).not.toMatch(/SkillAvatar|skillPreview/);
    expect(panel).toMatch(/description=\{t\("project_extensions\.skill_card_desc"\)\}/);
  });
});
