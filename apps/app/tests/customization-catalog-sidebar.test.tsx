/** @jsxImportSource react */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import type { DenOrgPlugin } from "../src/app/lib/den";
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
    expect(route).toContain('requestOpenMarketplacePlugin(item.name)');
    expect(route).toContain('plugins: extensionsSnapshot.cloudOrgPlugins');
    expect(route).toContain('connectors: standaloneGlobalConnectors');
    expect(route).toContain('route.tab === "skills" || Boolean(props.pluginCatalogOnly)');
    expect(route).toContain('route.tab === "connectors" || Boolean(props.pluginCatalogOnly)');
    expect(route).not.toContain('plugins: extensionsSnapshot.importedCloudPlugins');
  });

  test("lists only catalog-ready plugins and explicitly global skills/connectors", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("ready", "ready"), plugin("desktop", "desktop_only"), plugin("signin", "needs_signin")],
      skills: [{ name: "Global Skill", path: "/global/skills/global" }],
      connectors: [{ name: "Global Connector" }],
      localPlugins: [{ id: "builtin:browser", name: "Browser" }],
    });
    expect(items).toEqual([
      { id: "builtin:browser", name: "Browser", section: "plugins" },
      { id: "global-connector:Global Connector", name: "Global Connector", section: "connectors" },
      { id: "global-skill:/global/skills/global", name: "Global Skill", section: "skills" },
      { id: "cloud-plugin:ready", name: "ready", section: "plugins" },
    ]);
  });

  test("does not infer installation from a workspace import ledger", () => {
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("desktop", "desktop_only")],
      skills: [],
      connectors: [],
    });
    expect(items).toEqual([]);
  });

  test("category and installed shortcuts dispatch their section without workspace actions", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const selected: CustomizationCatalogSection[] = [];
    const installed: string[] = [];
    const items = globalCustomizationInstalledItems({
      plugins: [plugin("ready", "ready")],
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
    await act(async () => button("customization-installed-global-skill:/global/skill").props.onClick());
    expect(selected).toEqual(["skills", "connectors"]);
    expect(installed).toEqual(["plugins:ready", "skills:Skill"]);
    await act(async () => renderer!.unmount());
  });
});
