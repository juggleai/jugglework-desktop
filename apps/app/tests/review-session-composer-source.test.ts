import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/react-app/domains/reviews/review-session-composer.tsx", import.meta.url)).text();
const panelSource = await Bun.file(new URL("../src/react-app/domains/reviews/review-conversation-panel.tsx", import.meta.url)).text();

test("review composer uses the source workspace model catalog but submits to the isolated review workspace", () => {
  expect(source).toContain("const catalogOpencodeBaseUrl = endpoint.opencodeBaseUrl");
  expect(source).toContain("listAutomationDependencies(endpoint.workspaceId)");
  expect(source).toContain("startSessionRun(workspaceId, sessionId");
  expect(source).toContain("useSessionPermissionMode({ client: endpoint.client, workspaceId, sessionId })");
});

test("layout options close both menus before requesting a layout change", () => {
  expect(panelSource).toContain("setQuickMenuOpen(false)");
  expect(panelSource).toContain("setDockedMenuOpen(false)");
  expect(panelSource).toContain("props.onLayoutChange(layout)");
  expect(panelSource).toContain('onClick={() => chooseLayout("right")}');
});
