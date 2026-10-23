import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  connectorStatusLabel,
  formatLocalCommand,
  parseLocalCommand,
} from "../src/react-app/domains/settings/pages/global-connectors-view";

const globalSkills = readFileSync(
  new URL("../src/react-app/domains/settings/pages/global-skills-view.tsx", import.meta.url),
  "utf8",
);
const globalConnectors = readFileSync(
  new URL("../src/react-app/domains/settings/pages/global-connectors-view.tsx", import.meta.url),
  "utf8",
);
const catalogSource = readFileSync(
  new URL("../src/react-app/domains/settings/pages/catalog-source.tsx", import.meta.url),
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
    expect(globalSkills).toContain("group-hover:opacity-100");
    expect(globalSkills).toContain("<Trash2");
    expect(globalSkills).not.toContain("settings.provider_view_details");
    expect(globalSkills).not.toContain('variant="destructive"');
    expect(globalSkills).toContain("<CatalogHeader");
    expect(catalogSource).toContain('size="icon-sm"');
    expect(catalogSource).toContain('aria-label={t("common.refresh")}');
    expect(globalSkills).not.toContain('<Button variant="outline" disabled={props.busy} onClick={props.onRefresh}>');
  });

  test("global connectors retain their top-right add action", () => {
    expect(globalConnectors).toContain("<Plus size={14} />");
    expect(globalConnectors).toContain("props.onAddConnector");
    expect(globalConnectors).toContain("<CatalogHeader");
    expect(catalogSource).toContain('size="icon-sm"');
    expect(catalogSource).toContain('aria-label={t("common.refresh")}');
    expect(globalConnectors).not.toContain('<Button variant="outline" disabled={props.busy} onClick={props.onRefresh}>');
    expect(globalConnectors).toContain('onClick={() => openEditor(connector)}');
    expect(globalConnectors).toContain("saveDetail");
    expect(globalConnectors).not.toContain('onClick={() => runWrite(props.onToggleEnabled(connector.name, !enabled))}');
    expect(globalConnectors).not.toContain('onClick={() => setRemoveTarget(connector)}');
    expect(globalConnectors).toContain("function GlobalConnectorAvatar");
    expect(globalConnectors).toContain("resolveExtensionIconUrl");
    expect(globalConnectors).toContain("<ExtensionMeshAvatar");
    expect(globalConnectors).toContain('<GlobalConnectorAvatar name={connector.name}');
    expect(globalConnectors).toContain('<GlobalConnectorAvatar name={entry.name}');
    expect(globalConnectors).toContain("directoryEntries.map");
    expect(globalConnectors).toContain("props.onConnectDirectory(entry)");
    expect(globalConnectors).toContain("const [detailSelection, setDetailSelection]");
    expect(globalConnectors).toContain("connector.name === selection.id");
    expect(globalConnectors).toContain('resolveConnectorCatalogSource(connector, publicEntries) === props.source');
    expect(globalConnectors).not.toContain("[detailTarget, setDetailTarget] = useState<GlobalConnectorItem | null>(null)");
    expect(globalConnectors).toContain("connectorReadiness(connector.config, connector.status).label");
    expect(globalConnectors).not.toContain('connectorStatusLabel(connector.status) ?? t("mcp.status_connected")');
  });

  test("unknown connector engine status is not presented as connected", () => {
    expect(connectorStatusLabel(undefined)).toBeNull();
  });

  test("local connector command arguments round-trip without normalization", () => {
    const command = [
      "C:\\Program Files\\nodejs\\npx.cmd",
      "--label=hello world",
      "quoted \"value\"",
      "",
      "line one\nline two",
    ];

    expect(parseLocalCommand(formatLocalCommand(command))).toEqual(command);
  });

  test("invalid local connector command drafts cannot produce a mutation value", () => {
    expect(parseLocalCommand("npx -y server")).toBeNull();
    expect(parseLocalCommand('{"command":["npx"]}')).toBeNull();
    expect(parseLocalCommand('["npx", 1]')).toBeNull();
    expect(parseLocalCommand("[]")).toBeNull();
  });

  test("global skill imports explicitly target global scope", () => {
    expect(route).toContain('listSkills(workspaceId, { scope: "global" })');
    expect(route).toContain('importSkill("", dir, { overwrite: false, scope: "global" })');
  });

  test("personal skill reads and deletes target the selected runtime", () => {
    const refresh = route.slice(route.indexOf("const refreshGlobalSkills ="), route.indexOf("const refreshGlobalConnectors ="));
    const remove = route.slice(route.indexOf("const deleteGlobalSkill ="), route.indexOf("const canAddSkills ="));
    for (const block of [refresh, remove]) {
      expect(block).toContain("const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient");
      expect(block).toContain("const workspaceId = runtimeWorkspaceId?.trim()");
      expect(block).not.toContain("routeStateRef.current.runtimeWorkspaceId");
    }
    expect(remove).toContain('await client.deleteSkill(workspaceId, name, { scope: "global" })');
    expect(route).toContain('const canAddSkills = selectedWorkspace?.workspaceType === "local"');
    expect(route).toContain("canAddSkills={canAddSkills}");
    expect(route).toContain("if (!canAddSkills || !globalInventoryScope.active) return");
  });

  test("personal inventory reads fence stale success, errors and cleanup", () => {
    const scope = route.slice(route.indexOf("const globalInventoryScope ="), route.indexOf("const refreshGlobalSkills ="));
    expect(scope).toContain("[inventoryClient, runtimeWorkspaceId, globalConfigTarget]");
    expect(scope).toContain("globalInventoryScope.active = false");
    expect(scope).toContain("globalInventoryScope.skillsRequest++");
    expect(scope).toContain("globalInventoryScope.connectorsRequest++");
    const refresh = route.slice(route.indexOf("const refreshGlobalSkills ="), route.indexOf("const connectorsTabActive ="));
    expect(refresh.match(/if \(!isCurrent\(\)\) return/g)).toHaveLength(4);
    expect(refresh).toContain("if (isCurrent()) setGlobalSkillsBusy(false)");
    const plugins = route.slice(route.indexOf("const inventoryClient ="), route.indexOf("const opencodeClient =", route.indexOf("const inventoryClient =")));
    expect(plugins).toContain("if (!active) return");
    expect(plugins).toContain("if (active) setSessionPluginError");
    expect(plugins).toContain("return () => { active = false; }");
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

  test("global connector writes are fenced against overlapping config rewrites", () => {
    expect(route).toContain("globalConnectorWriteInFlightRef.current");
    expect(route).toContain('if (globalConnectorWriteInFlightRef.current) throw new Error(t("common.saving"))');
    expect(globalConnectors).toContain("const mutationPending = Boolean(props.pendingConnectorName)");
    expect(globalConnectors).toContain("disabled={props.busy || mutationPending || submitting || authorizationBusy}");
  });
});
