import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const readSource = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  "utf8",
);

describe("session-scoped agent selection wiring", () => {
  test("sends the agent selected for the target session, not the routed session", () => {
    const route = readSource("../src/react-app/shell/session-route.tsx");
    expect(route).toContain("agent: readSessionAgentChoice(selectedWorkspaceId, targetSessionId) ?? undefined");
    expect(route).not.toContain("agent: selectedAgent ?? undefined");
    expect(route).toContain("migrateLegacyAgentChoice(selectedWorkspaceId, selectedSessionId, legacySelectedAgent)");
    expect(route).toContain("selectedAgent: null");
    expect(route).toContain("setSessionAgentChoice(selectedWorkspaceId, sessionId, null)");
    expect(route).toContain("selectedAgent={resolveAgentForSession(paletteSessionId)}");
    expect(route).toContain("onSelectAgent={(agent) => setSelectedAgent(agent, paletteSessionId)}");
  });

  test("both panes bind their own agent control and the badge has its own short label", () => {
    const page = readSource("../src/react-app/domains/session/chat/session-page.tsx");
    const composer = readSource("../src/react-app/domains/session/surface/composer/composer.tsx");
    expect(page).toContain("resolveSessionAgentProps?.(props.selectedSessionId!)");
    expect(page).toContain("resolveSessionAgentProps?.(splitSessionId!)");
    expect(composer).toContain('t("composer.agent_plan_badge")');
    expect(composer).toContain('t("composer.agent_plan_mode")');
    expect(composer).toContain("onClick={() => props.onSelectAgent(null)}");
  });
});
