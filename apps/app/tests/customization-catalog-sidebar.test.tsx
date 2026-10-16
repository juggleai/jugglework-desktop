/** @jsxImportSource react */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import type { DenOrgPlugin } from "../src/app/lib/den";
import { t } from "../src/i18n";
import {
  CustomizationCatalogSidebar,
  globalCustomizationInstalledItems,
  type CustomizationCatalogSection,
} from "../src/react-app/domains/settings/shell/customization-catalog-sidebar";

const plugin = (id: string, state: "ready" | "desktop_only" | "needs_signin"): DenOrgPlugin => ({
  id,
  name: id,
  description: null,
  status: "active",
  memberCount: 1,
  updatedAt: null,
  componentCounts: state === "desktop_only" ? { hook: 1 } : { skill: 1 },
  cloudReadiness: { state, hasInstructional: state !== "desktop_only", connections: [], components: [] },
});

describe("global Plugins sidebar", () => {
  test("routes categories to global views while leaving plugin discovery in application catalog mode", () => {
    const route = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
    expect(route).toContain('section === "plugins" ? "extensions/plugins" : section');
    expect(route).toContain('<GlobalSkillsView');
    expect(route).toContain('<GlobalConnectorsView');
    expect(route).toContain('id: item.detailId ?? item.id');
    expect(route).toContain('detailRequest={catalogRequestFor("plugins")}');
    expect(route).toContain('detailRequest={catalogRequestFor("skills")}');
    expect(route).toContain('detailRequest={catalogRequestFor("connectors")}');
    expect(route).toContain('plugins: extensionsSnapshot.cloudOrgPlugins');
    expect(route).toContain('connectors: standaloneGlobalConnectors');
    expect(route).toContain('const publicEntry = matchPublicConnector(connector, publicConnectorEntries)');
    expect(route).toContain('iconSrc: item.builtInEntry?.iconSrc');
    expect(route).toContain('connectors: orgMcpConnections.connections.filter(isOrgMcpConnectionReady)');
    expect(route).toContain('route.tab === "skills" || Boolean(props.pluginCatalogOnly)');
    expect(route).toContain('route.tab === "connectors" || Boolean(props.pluginCatalogOnly)');
    expect(route).toContain('skills={props.pluginCatalogOnly ? standaloneCatalogSkills : globalSkills}');
    expect(route).toContain('organizationSkills={[]}');
    expect(route).toContain('const hasOrganizationCatalog = cloudSession.isSignedIn');
    expect(route).toContain('!isPersonalDenOrganization(cloudSession.activeOrganization)');
    expect(route).toContain('showOrganization={hasOrganizationCatalog}');
    expect(route).toContain('includeOrganization: hasOrganizationCatalog');
    expect(route).toContain('source={effectiveCatalogSource}');
    expect(route).not.toContain('plugins: extensionsSnapshot.importedCloudPlugins');
  });

  test("lists only explicitly installed plugins and global skills/connectors", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("ready", "ready"), plugin("desktop", "desktop_only"), plugin("signin", "needs_signin")],
      installedPluginIds: ["ready"],
      skills: [{ name: "Global Skill", path: "/global/skills/global" }],
      connectors: [{ name: "Global Connector" }],
      localPlugins: [{ id: "builtin:browser", name: "Browser", source: "public" }],
    });
    expect(items).toEqual([
      { id: "builtin:browser", name: "Browser", section: "plugins", source: "public" },
      { id: "global-connector:Global Connector", name: "Global Connector", section: "connectors", source: "personal" },
      { id: "global-skill:/global/skills/global", name: "Global Skill", section: "skills", source: "personal" },
      { id: "cloud-plugin:ready", name: "ready", section: "plugins", source: "organization", sourceLabel: undefined },
    ]);
  });

  test("includes an explicitly installed workspace Marketplace plugin without promoting other rows", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("desktop", "desktop_only"), plugin("other", "desktop_only")],
      installedPluginIds: ["desktop"],
      skills: [],
      connectors: [],
    });
    expect(items).toEqual([{
      id: "cloud-plugin:desktop",
      name: "desktop",
      section: "plugins",
      source: "organization",
      sourceLabel: undefined,
    }]);
  });

  test("uses host registry records as the authoritative Installed plugin inventory", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("not-installed", "desktop_only")],
      installedPluginIds: ["not-installed"],
      hostInstallations: [{
        pluginId: "host-installed",
        marketplaceId: "marketplace",
        name: "Host installed",
        description: "Installed on the execution host",
        packageRevision: "revision-1",
        packageDigest: "digest",
        status: "installed",
        resources: [],
        installedAt: 1,
        updatedAt: 1,
      }],
      skills: [],
      connectors: [],
      organization: { id: "team", name: "Team", skills: [], connectors: [] },
    });

    expect(items).toEqual([{
      id: "cloud-plugin:host-installed",
      name: "Host installed",
      section: "plugins",
      source: "organization",
      sourceLabel: "Team",
    }]);
  });

  test("classifies skills by public provenance instead of name", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [],
      skills: [
        { name: "skill-creator", path: "/global/skills/managed-skill-creator", sourceKind: "public" },
        { name: "skill-creator", path: "/global/skills/user-skill-creator", sourceKind: "standalone" },
        { name: "writer", path: "/global/skills/writer" },
      ],
      connectors: [],
    });

    expect(items.filter((item) => item.name === "skill-creator").map((item) => item.source)).toEqual(["public", "personal"]);
    expect(items.find((item) => item.name === "writer")?.source).toBe("personal");
  });

  test("does not add a plugin-owned skill shortcut after standalone catalog filtering", () => {
    const skills = [
      { name: "Plugin component", path: "/skills/plugin/SKILL.md", ownerPluginId: "plugin-1" },
      { name: "Standalone", path: "/skills/standalone/SKILL.md" },
    ];
    const items = globalCustomizationInstalledItems({ plugins: [], skills, connectors: [] });
    expect(items.map((item) => item.name)).toEqual(["Standalone"]);
  });

  test("installed aggregates source-qualified organization and personal names without merging them", () => {
    const base = { plugins: [], skills: [{ name: "Writer", path: "/skills/writer" }], connectors: [{ name: "Notion", source: "public" as const }] };
    const organization = { id: "team-a", name: "Team A", skills: [{ id: "writer", name: "Writer" }], connectors: [{ id: "notion", name: "Notion" }] };
    const items = globalCustomizationInstalledItems({ ...base, organization });
    expect(items.filter((item) => item.name === "Writer").map((item) => item.source).sort()).toEqual(["organization", "personal"]);
    expect(items.filter((item) => item.name === "Notion").map((item) => item.source).sort()).toEqual(["organization", "public"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(4);
    expect(items.find((item) => item.id === "org-connector:team-a:notion")?.sourceLabel).toBe("Team A");
    const switched = globalCustomizationInstalledItems({ ...base, organization: { ...organization, id: "personal-org", name: "My org", skills: [], connectors: [] } });
    expect(switched).toHaveLength(2);
    expect(switched.some((item) => item.id.includes("team-a"))).toBe(false);
  });

  test("omits organization-installed shortcuts for a personal organization", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("cloud-plugin", "ready")],
      installedPluginIds: ["cloud-plugin"],
      skills: [{ name: "Personal Skill", path: "/skills/personal" }],
      connectors: [{ name: "Personal Connector" }],
      organization: {
        id: "personal-org",
        name: "Personal",
        skills: [{ id: "org-skill", name: "Organization Skill" }],
        connectors: [{ id: "org-connector", name: "Organization Connector" }],
      },
      includeOrganization: false,
    });
    expect(items.map((item) => item.name)).toEqual(["Personal Connector", "Personal Skill"]);
    expect(items.some((item) => item.source === "organization")).toBe(false);
  });

  test("carries installed plugin and connector icon metadata", () => {
    const cloudPlugin = plugin("Cloud plugin", "ready");
    cloudPlugin.extension = {
      id: "cloud-plugin",
      name: "Cloud plugin",
      description: null,
      sourceFormat: "jugglework-extension-manifest",
      manifest: {
        schemaVersion: 1,
        id: "cloud-plugin",
        name: "Cloud plugin",
        description: "Cloud plugin",
        source: { format: "jugglework-extension-manifest", trusted: true },
        icon: { src: "https://example.com/plugin.svg", simpleIconSlug: "example" },
        resources: [],
      },
    };
    const items = globalCustomizationInstalledItems({
      plugins: [cloudPlugin],
      installedPluginIds: [cloudPlugin.id],
      skills: [],
      connectors: [{ name: "Public connector", source: "public", iconSlug: "notion", url: "https://mcp.notion.com" }],
      localPlugins: [{ id: "builtin:browser", name: "Browser", source: "public", iconSrc: "/browser.svg" }],
      organization: { id: "team", name: "Team", skills: [], connectors: [{ id: "linear", name: "Linear", url: "https://mcp.linear.app" }] },
    });

    expect(items.find((item) => item.id === "cloud-plugin:Cloud plugin")).toMatchObject({ iconSrc: "https://example.com/plugin.svg", iconSlug: "example" });
    expect(items.find((item) => item.id === "builtin:browser")).toMatchObject({ iconSrc: "/browser.svg" });
    expect(items.find((item) => item.id === "global-connector:Public connector")).toMatchObject({ iconSlug: "notion", url: "https://mcp.notion.com" });
    expect(items.find((item) => item.id === "org-connector:team:linear")).toMatchObject({ url: "https://mcp.linear.app" });
  });

  test("renders resolved image icons, skill avatars, and category fallbacks without fetching", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const items = [
      { id: "plugin:image", name: "Image plugin", section: "plugins" as const, iconSlug: "figma" },
      { id: "plugin:fallback", name: "Fallback plugin", section: "plugins" as const },
      { id: "skill:writer", name: "Writer", section: "skills" as const },
      { id: "connector:url", name: "Notion", section: "connectors" as const, url: "https://mcp.notion.com/v1" },
      { id: "connector:fallback", name: "Custom", section: "connectors" as const },
    ];
    let renderer!: TestRenderer.ReactTestRenderer;
    const view = (section: CustomizationCatalogSection) => <CustomizationCatalogSidebar activeSection={section} installedItems={items} onSelectSection={() => {}} onSelectInstalledItem={() => {}} />;
    await act(async () => { renderer = TestRenderer.create(view("plugins")); });
    expect(renderer.root.findAllByType("img").map((image) => image.props.src)).toEqual(["https://cdn.simpleicons.org/figma"]);
    expect(renderer.root.findByProps({ "data-testid": "customization-installed-plugin:fallback" }).findAllByType("svg")).toHaveLength(1);
    await act(async () => renderer.update(view("skills")));
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.type === "span" && node.props["aria-hidden"] === true)).toHaveLength(1);
    await act(async () => renderer.update(view("connectors")));
    expect(renderer.root.findByType("img").props.src).toBe("https://www.google.com/s2/favicons?sz=64&domain=notion.com");
    expect(renderer.root.findByProps({ "data-testid": "customization-installed-connector:fallback" }).findAllByType("svg")).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  test("category and installed shortcuts dispatch their section without workspace actions", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const selected: CustomizationCatalogSection[] = [];
    const installed: string[] = [];
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("ready", "ready")],
      installedPluginIds: ["ready"],
      skills: [{ name: "Skill", path: "/global/skill" }],
      connectors: [{ name: "Connector" }],
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <CustomizationCatalogSidebar
          activeSection="plugins"
          installedItems={items}
          onSelectSection={(section) => selected.push(section)}
          onSelectInstalledItem={(item) => installed.push(`${item.section}:${item.name}`)}
        />,
      );
    });
    const button = (id: string) => renderer!.root.findByProps({ "data-testid": id });
    expect(button("customization-nav-plugins").props["data-active"]).toBe("true");
    await act(async () => button("customization-nav-skills").props.onClick());
    await act(async () => button("customization-nav-connectors").props.onClick());
    await act(async () => button("customization-installed-cloud-plugin:ready").props.onClick());
    expect(renderer!.root.findAllByProps({ "data-testid": "customization-installed-global-skill:/global/skill" })).toHaveLength(0);
    await act(async () => renderer!.update(
      <CustomizationCatalogSidebar activeSection="skills" installedItems={items} onSelectSection={(section) => selected.push(section)} onSelectInstalledItem={(item) => installed.push(`${item.section}:${item.name}`)} />,
    ));
    await act(async () => button("customization-installed-global-skill:/global/skill").props.onClick());
    expect(selected).toEqual(["skills", "connectors"]);
    expect(installed).toEqual(["plugins:ready", "skills:Skill"]);
    await act(async () => renderer!.unmount());
  });

  test("filters installed items by selected type, retains all sources, and uses the filtered empty state", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("Team plugin", "ready")],
      installedPluginIds: ["Team plugin"],
      skills: [],
      connectors: [{ name: "Notion", source: "public" }, { name: "Custom", source: "personal" }],
      organization: { id: "team", name: "Team", skills: [], connectors: [{ id: "team-connection", name: "Team connection" }] },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    const view = (section: CustomizationCatalogSection) => <CustomizationCatalogSidebar activeSection={section} installedItems={items} onSelectSection={() => {}} onSelectInstalledItem={() => {}} />;
    const installedButtons = () => renderer.root.findAllByType("button").filter((button) => button.props["data-testid"]?.startsWith("customization-installed-"));
    await act(async () => { renderer = TestRenderer.create(view("connectors")); });
    expect(installedButtons()).toHaveLength(3);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Team plugin");
    await act(async () => renderer.update(view("plugins")));
    expect(installedButtons()).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Notion");
    await act(async () => renderer.update(view("skills")));
    expect(installedButtons()).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain(t("customization.installed_empty"));
    await act(async () => renderer.unmount());
  });
});
