/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { t } from "../src/i18n";
import type { McpDirectoryInfo } from "../src/app/constants";
import { CatalogHeader, CatalogSourceTabs, type CatalogSource } from "../src/react-app/domains/settings/pages/catalog-source";

// Keep these tests focused on view behavior, without desktop file reads or portals.
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module("../src/react-app/design-system/modals/confirm-modal", () => ({ ConfirmModal: () => null }));
mock.module("../src/react-app/domains/settings/pages/project-extensions/skill-detail-modal", () => ({
  SkillDetailModal: ({ open, skill, loadSkillDetail }: { open: boolean; skill?: { content?: string; origin?: string }; loadSkillDetail?: unknown }) => open ? <div data-testid="local-detail"><span>Overview</span><span>Files</span><span>{skill?.content}</span><span data-loader={String(Boolean(loadSkillDetail))}>{skill?.origin}</span></div> : null,
}));
mock.module("../src/react-app/domains/settings/pages/project-extensions/skill-hub-modal", () => ({
  SkillHubModal: ({ open }: { open: boolean }) => open ? <div data-testid="skill-hub" /> : null,
}));
mock.module("../src/react-app/domains/settings/pages/project-extensions/skill-add-menu", () => ({
  SkillAddMenu: ({ disabled, onOpenSkillHub }: { disabled: boolean; onOpenSkillHub: () => void }) => <button data-testid="skill-add" disabled={disabled} onClick={onOpenSkillHub}>Add skill</button>,
}));

const { GlobalSkillsView } = await import("../src/react-app/domains/settings/pages/global-skills-view");
const { GlobalConnectorsView } = await import("../src/react-app/domains/settings/pages/global-connectors-view");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
async function render(node: ReactNode) {
  await act(async () => { renderer = TestRenderer.create(node); });
}
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
const text = () => JSON.stringify(renderer.toJSON());
const buttons = () => renderer.root.findAllByType("button");
const noop = () => {};
const skillProps = {
  busy: false,
  canAddSkills: true,
  skills: [{ name: "Personal writer", description: "Draft documents", path: "/global/writer" }],
  organizationSkills: [{ name: "Team reviewer", description: "Review changes", path: "", content: "Team instructions" }],
  projectDir: "/workspace",
  onDeleteSkill: noop,
  onUploadSkill: noop,
  onRefresh: noop,
};
const entries: McpDirectoryInfo[] = [
  { name: "Installed directory", serverName: "existing-server", description: "Installed entry", type: "remote", url: "https://example.com/mcp", oauth: false },
  { name: "Derived Name", description: "Derived server name", type: "local", command: ["example"], oauth: false },
  { name: "Available directory", serverName: "available-server", description: "Available entry", oauth: false },
];
const connectorProps = {
  busy: false,
  connectors: [
    { name: "existing-server", config: { type: "remote" as const, url: "https://example.com/mcp", enabled: false } },
    { name: "derived-name", config: { type: "local" as const, command: ["example"] } },
  ],
  unconnected: [entries[2]!],
  publicEntries: entries,
  onAddConnector: noop,
  onConnectDirectory: noop,
  onToggleEnabled: noop,
  onAuthorize: noop,
  onRemoveConnector: noop,
  onRefresh: noop,
};

describe("catalog source header", () => {
  test("renders ordered localized pills, the actual organization, and controlled changes", async () => {
    const changes: CatalogSource[] = [];
    await render(<CatalogSourceTabs value="organization" organizationName="Example Team" onChange={(source) => changes.push(source)} />);
    expect(buttons().map((button) => button.findByType("span").children.join(""))).toEqual([
      t("customization.source_public"), "Example Team", t("customization.source_personal"),
    ]);
    expect(buttons().map((button) => button.props["aria-pressed"])).toEqual([false, true, false]);
    for (const button of buttons()) await act(async () => button.props.onClick());
    expect(changes).toEqual(["public", "organization", "personal"]);
    expect(buttons()[1]!.props["aria-pressed"]).toBe(true);
    await act(async () => renderer.update(<CatalogSourceTabs value="public" organizationName="  " onChange={noop} />));
    expect(text()).toContain(t("customization.source_organization"));
  });

  test("hides the organization source for a personal organization", async () => {
    const changes: CatalogSource[] = [];
    await render(<CatalogSourceTabs value="public" organizationName="Personal" showOrganization={false} onChange={(source) => changes.push(source)} />);
    expect(buttons().map((button) => button.findByType("span").children.join(""))).toEqual([
      t("customization.source_public"),
      t("customization.source_personal"),
    ]);
    for (const button of buttons()) await act(async () => button.props.onClick());
    expect(changes).toEqual(["public", "personal"]);
  });

  test("exposes search and refresh while keeping source pills optional", async () => {
    const refresh = mock(noop);
    const search = mock(noop);
    await render(<CatalogHeader title="Catalog" description="Description" busy={false} onRefresh={refresh} search={{ value: "", onChange: search, placeholder: "Search catalog" }} />);
    expect(renderer.root.findAllByType(CatalogSourceTabs)).toHaveLength(0);
    await act(async () => renderer.root.findByType("input").props.onChange({ currentTarget: { value: "query" } }));
    await act(async () => buttons().find((button) => button.props["aria-label"] === t("common.refresh"))!.props.onClick());
    expect(search).toHaveBeenCalledWith("query");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("global skill sources", () => {
  test.each(["public", "organization", "personal"] as const)("%s upload navigates only after explicit success", async (source) => {
    const changed = mock(noop);
    let succeed = false;
    await render(<GlobalSkillsView {...skillProps} source={source} onSourceChange={changed} onUploadSkill={async () => succeed} />);
    const menu = () => renderer.root.find((node) => typeof node.props.onUpload === "function");
    await act(async () => menu().props.onUpload());
    expect(changed).not.toHaveBeenCalled();
    succeed = true;
    await act(async () => menu().props.onUpload());
    expect(changed).toHaveBeenCalledWith("personal");
  });

  test("failed upload keeps the source and exposes the error", async () => {
    const changed = mock(noop);
    await render(<GlobalSkillsView {...skillProps} source="organization" onSourceChange={changed} onUploadSkill={async () => { throw new Error("Import rejected"); }} />);
    await act(async () => renderer.root.find((node) => typeof node.props.onUpload === "function").props.onUpload());
    expect(changed).not.toHaveBeenCalled();
    expect(text()).toContain("Import rejected");
  });

  test("source changes preserve search without replacing the input and stale upload cannot redirect", async () => {
    const changed = mock(noop);
    let complete!: (value: boolean) => void;
    const upload = () => new Promise<boolean>((resolve) => { complete = resolve; });
    await render(<GlobalSkillsView {...skillProps} source="public" onUploadSkill={upload} onSourceChange={changed} />);
    const input = renderer.root.findByType("input");
    await act(async () => input.props.onChange({ currentTarget: { value: "writer" } }));
    let pending!: Promise<void>;
    await act(async () => { pending = renderer.root.find((node) => typeof node.props.onUpload === "function").props.onUpload(); });
    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="organization" onUploadSkill={upload} onSourceChange={changed} />));
    expect(renderer.root.findByType("input")).toBe(input);
    expect(input.props.value).toBe("writer");
    await act(async () => { complete(true); await pending; });
    expect(changed).not.toHaveBeenCalled();
  });

  test("SkillHub can open from organization and successful install refreshes Personal then navigates", async () => {
    const changed = mock(noop);
    const refreshPersonal = mock(noop);
    const refreshOrg = mock(noop);
    await render(<GlobalSkillsView {...skillProps} source="organization" onSourceChange={changed} onRefreshPersonal={refreshPersonal} onRefresh={refreshOrg} />);
    await act(async () => renderer.root.findByProps({ "data-testid": "skill-add" }).props.onClick());
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(1);
    const hub = renderer.root.find((node) => typeof node.props.onInstalled === "function");
    await act(async () => hub.props.onInstalled({ installedCount: 0, failedCount: 1 }));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => hub.props.onInstalled({ installedCount: 1, failedCount: 0 }));
    expect(refreshPersonal).toHaveBeenCalledTimes(2);
    expect(refreshOrg).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith("personal");
  });

  test("remote environments disable bridge installs and close an already open SkillHub", async () => {
    const upload = mock(noop);
    await render(<GlobalSkillsView {...skillProps} source="personal" onUploadSkill={upload} />);
    await act(async () => renderer.root.findByProps({ "data-testid": "skill-add" }).props.onClick());
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(1);

    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="personal" canAddSkills={false} onUploadSkill={upload} />));
    const add = renderer.root.findByProps({ "data-testid": "skill-add" });
    expect(add.props.disabled).toBe(true);
    await act(async () => add.props.onClick());
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(0);
    const menu = renderer.root.find((node) => typeof node.props.onUpload === "function");
    await act(async () => menu.props.onUpload());
    expect(upload).not.toHaveBeenCalled();
    expect(buttons().some((button) => button.props["aria-label"] === t("skills.uninstall"))).toBe(true);

    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="personal" />));
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(0);
  });

  test("legacy and personal views retain local skills, search, uninstall and personal SkillHub", async () => {
    await render(<GlobalSkillsView {...skillProps} />);
    expect(renderer.root.findAllByType(CatalogSourceTabs)).toHaveLength(0);
    expect(text()).toContain("Personal writer");
    expect(text()).not.toContain("Team reviewer");
    expect(buttons().some((button) => button.props["aria-label"] === t("skills.uninstall"))).toBe(true);
    await act(async () => renderer.root.findByProps({ "data-testid": "skill-add" }).props.onClick());
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(1);
    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="personal" />));
    expect(renderer.root.findAllByProps({ "data-testid": "skill-hub" })).toHaveLength(0);
    await act(async () => renderer.root.findByType("input").props.onChange({ currentTarget: { value: " DRAFT " } }));
    expect(text()).toContain("Personal writer");
    await act(async () => renderer.root.findByType("input").props.onChange({ currentTarget: { value: "missing" } }));
    expect(text()).not.toContain("Personal writer");
    expect(text()).toContain(t("chat.no_search_results"));
  });

  test("public lists curated skills, offers personal add, and hides local errors", async () => {
    await render(<GlobalSkillsView {...skillProps} source="public" error="Local error" />);
    expect(text()).toContain("skill-creator");
    expect(text()).not.toContain("Personal writer");
    expect(text()).not.toContain("Team reviewer");
    expect(text()).not.toContain("Local error");
    expect(renderer.root.findAllByProps({ "data-testid": "skill-add" })).toHaveLength(1);
  });

  test("organization details are read-only and do not open the local skill reader", async () => {
    await render(<GlobalSkillsView {...skillProps} source="organization" />);
    expect(text()).toContain("Team reviewer");
    expect(text()).not.toContain("Personal writer");
    expect(renderer.root.findAllByProps({ "data-testid": "skill-add" })).toHaveLength(1);
    expect(buttons().some((button) => button.props["aria-label"] === t("skills.uninstall"))).toBe(false);
    const card = buttons().find((button) => button.findAllByType("div").some((div) => div.children.includes("Team reviewer")))!;
    await act(async () => card.props.onClick());
    expect(text()).toContain("Team instructions");
    expect(text()).toContain("Overview");
    expect(text()).toContain("Files");
    expect(text()).toContain("jugglework-connect");
    expect(text()).toContain('data-loader":"false"');
    expect(renderer.root.findAllByProps({ "data-testid": "local-detail" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="personal" />));
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  test("organization loading and error are independent of personal status", async () => {
    await render(<GlobalSkillsView {...skillProps} source="organization" orgSkillsLoading status="Personal status" error="Personal error" />);
    expect(text()).toContain(t("common.loading"));
    expect(text()).not.toContain("Team reviewer");
    expect(text()).not.toContain("Personal status");
    expect(text()).not.toContain("Personal error");
    expect(buttons().find((button) => button.props["aria-label"] === t("common.refresh"))!.props.disabled).toBe(true);
    await act(async () => renderer.update(<GlobalSkillsView {...skillProps} source="organization" organizationSkills={[]} orgSkillsError="Organization failed" />));
    expect(text()).toContain("Organization failed");
    expect(text()).not.toContain(t("skills.no_skills_found"));
  });
});

describe("global connector sources", () => {
  test("public includes installed entries without duplicate add and uses server names", async () => {
    const connect = mock(noop);
    await render(<GlobalConnectorsView {...connectorProps} source="public" onConnectDirectory={connect} />);
    for (const entry of entries) expect(text()).toContain(entry.name);
    expect(renderer.root.findAllByType("span").filter((span) => span.children.includes(t("customization.installed")))).toHaveLength(2);
    const addButtons = buttons().filter((button) => button.children.includes(t("project_extensions.connect")));
    expect(addButtons).toHaveLength(1);
    await act(async () => addButtons[0]!.props.onClick());
    expect(connect).toHaveBeenCalledWith(entries[2]);
    expect(buttons().some((button) => button.children.includes(t("global_connectors.add")))).toBe(true);
    await act(async () => renderer.root.findByType("input").props.onChange({ currentTarget: { value: "existing-server" } }));
    expect(text()).toContain(entries[0]!.name);
    expect(text()).not.toContain(entries[2]!.name);
  });

  test("public never falls back to unconnected entries or invents installed state", async () => {
    await render(<GlobalConnectorsView {...connectorProps} source="public" publicEntries={undefined} />);
    expect(text()).not.toContain(entries[2]!.name);
    await act(async () => renderer.update(<GlobalConnectorsView {...connectorProps} source="public" connectors={[]} />));
    expect(buttons().filter((button) => button.children.includes(t("project_extensions.connect")))).toHaveLength(3);
  });

  test("personal shows only configured connectors and custom add; legacy retains directory", async () => {
    const connectors = [...connectorProps.connectors, { name: "custom-server", config: { type: "remote" as const, url: "https://custom.example/mcp" } }];
    await render(<GlobalConnectorsView {...connectorProps} connectors={connectors} source="personal" />);
    expect(text()).toContain("custom-server");
    expect(text()).not.toContain("existing-server");
    expect(text()).not.toContain("derived-name");
    expect(text()).not.toContain(entries[2]!.name);
    expect(buttons().some((button) => button.children.includes(t("global_connectors.add")))).toBe(true);
    await act(async () => renderer.update(<GlobalConnectorsView {...connectorProps} />));
    expect(renderer.root.findAllByType(CatalogSourceTabs)).toHaveLength(0);
    expect(text()).toContain("existing-server");
    expect(text()).toContain(entries[2]!.name);
  });

  test("organization replaces local inventory but retains search and custom add", async () => {
    await render(<GlobalConnectorsView {...connectorProps} source="organization" error="Personal error" organizationContent={<div>Parent organization content</div>} />);
    expect(text()).toContain("Parent organization content");
    expect(text()).not.toContain("existing-server");
    expect(text()).not.toContain(entries[2]!.name);
    expect(text()).not.toContain("Personal error");
    expect(buttons().some((button) => button.children.includes(t("global_connectors.add")))).toBe(true);
    expect(renderer.root.findAllByType("input")).toHaveLength(1);
  });
});
