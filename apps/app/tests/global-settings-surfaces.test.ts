import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const globalSkills = readFileSync(
  new URL("../src/react-app/domains/settings/pages/global-skills-view.tsx", import.meta.url),
  "utf8",
);
const globalConnectors = readFileSync(
  new URL("../src/react-app/domains/settings/pages/global-connectors-view.tsx", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../src/react-app/shell/settings-route.tsx", import.meta.url),
  "utf8",
);

describe("personal global settings surfaces", () => {
  test("global skills use a two-column list and the shared add menu", () => {
    expect(globalSkills).toContain('className="grid grid-cols-1 gap-2 sm:grid-cols-2"');
    expect(globalSkills).toContain("<SkillAddMenu");
    expect(globalSkills).toContain('scope="global"');
  });

  test("global connectors retain their top-right add action", () => {
    expect(globalConnectors).toContain("<Plus size={14} />");
    expect(globalConnectors).toContain("props.onAddConnector");
    expect(globalConnectors).toContain("props.unconnected.map");
    expect(globalConnectors).toContain("props.onConnectDirectory(entry)");
  });

  test("global skill imports explicitly target global scope", () => {
    expect(route).toContain('listSkills(workspaceId, { scope: "global" })');
    expect(route).toContain('importSkill("", dir, { overwrite: false, scope: "global" })');
  });

  test("global connectors merge the selected runtime global inventory", () => {
    expect(route).toContain("mergeGlobalMcpEntries(globalMcpEntries, connectionsSnapshot.mcpServers)");
    expect(route).toContain("selectedWorkspaceEndpoint?.client ?? juggleworkClient");
  });

  test("session connectors hide the auto-managed JuggleWork Cloud transport", () => {
    expect(route).toContain('server.name !== "jugglework-cloud"');
    expect(route).toContain('getMcpServerName(entry) !== "jugglework-cloud"');
  });

  test("global quick connect excludes hidden transports and writes global config", () => {
    expect(route).toContain("connectionsStore.quickConnect.filter");
    expect(route).toContain('entry.type !== "remote" && entry.type !== "local"');
    expect(route).toContain('name === "jugglework-cloud" || entry.defaultHidden');
    expect(route).toContain("globalMcpConfigFromDirectory(entry)");
    expect(route).toContain("onConnectDirectory={connectGlobalDirectory}");
  });
});
