/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { t } from "../src/i18n";
import { Button } from "../src/components/ui/button";
import type { McpDirectoryInfo } from "../src/app/constants";
import type { McpServerConfig } from "../src/app/types";
import type { GlobalConnectorsViewProps } from "../src/react-app/domains/settings/pages/global-connectors-view";
import { CatalogHeader, type CatalogSource } from "../src/react-app/domains/settings/pages/catalog-source";
import { matchPublicConnector } from "../src/react-app/domains/settings/pages/connector-catalog-source";
import { formatConfigWithMcpEntry, parseGlobalMcpEntries } from "../src/react-app/domains/settings/state/global-mcp-config";

mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module("../src/react-app/design-system/modals/confirm-modal", () => ({
  ConfirmModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? <div data-testid="remove-dialog"><button onClick={onConfirm}>Confirm removal</button></div> : null,
}));
mock.module("../src/react-app/domains/settings/pages/catalog-detail-page", () => ({
  CatalogDetailPage: ({ categoryLabel, name, onBack, children, icon, description, actions }: {
    categoryLabel: string; name: string; onBack: () => void; children: ReactNode;
    icon?: ReactNode; description?: string; actions?: ReactNode;
  }) => <section data-testid="detail-page"><button onClick={onBack}>{categoryLabel}</button>{icon}<h1>{name}</h1><p>{description}</p>{actions}{children}</section>,
}));

const { GlobalConnectorsView } = await import("../src/react-app/domains/settings/pages/global-connectors-view");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const defaults: GlobalConnectorsViewProps = {
  busy: false,
  source: "public",
  organizationName: "Team",
  connectors: [{ name: "Existing", config: { type: "remote", url: "https://existing.example/mcp" } }],
  unconnected: [],
  publicEntries: [{ name: "Directory entry", description: "Public connector", oauth: false }],
  onAddConnector: noop,
  onConnectDirectory: noop,
  onToggleEnabled: noop,
  onAuthorize: noop,
  onRemoveConnector: noop,
  onRefresh: noop,
};
let renderer: TestRenderer.ReactTestRenderer | undefined;
let props: GlobalConnectorsViewProps;
async function render(overrides: Partial<GlobalConnectorsViewProps> = {}) {
  props = { ...defaults, ...overrides };
  await act(async () => { renderer = TestRenderer.create(<GlobalConnectorsView {...props} />); });
}
async function update(overrides: Partial<GlobalConnectorsViewProps>) {
  props = { ...props, ...overrides };
  await act(async () => { renderer!.update(<GlobalConnectorsView {...props} />); });
}
async function unmount() {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
}
afterEach(unmount);
const root = () => renderer!.root;
const text = () => JSON.stringify(renderer!.toJSON());
async function click(label: string) {
  await act(async () => { root().findAllByType("button").find((button) => button.children.includes(label))!.props.onClick(); });
}
async function fill(placeholder: string, value: string) {
  await act(async () => { root().findByProps({ placeholder }).props.onChange({ currentTarget: { value } }); });
}
async function openAdd() {
  await click(t("global_connectors.add"));
  await fill("context7", "custom");
  await fill("https://example.com/mcp", "https://custom.example/mcp");
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("public installed GitHub shows actual readiness and never offers OAuth for token configuration", async () => {
  const github: McpDirectoryInfo = { id: "github", serverName: "github", name: "GitHub", description: "Runtime token required", type: "remote", url: "https://example.com/github", oauth: false };
  const connector = { name: "github", config: { type: "remote" as const, url: github.url, oauth: false as const }, catalogSource: "public" as const, catalogId: "github" };
  await render({ publicEntries: [github], connectors: [connector] });
  expect(text()).toContain(t("customization.installed"));
  expect(text()).toContain(t("mcp.readiness_unverified"));
  await update({ connectors: [{ ...connector, status: { status: "failed", error: "synthetic-private-detail" } }] });
  expect(text()).toContain(t("mcp.readiness_disconnected"));
  expect(text()).not.toContain(t("mcp.readiness_token_hint"));
  expect(text()).not.toContain(t("mcp.readiness_failed_hint"));
  expect(text()).not.toContain("synthetic-private-detail");
  await click(t("common.edit"));
  await update({ connectors: [{ ...connector, status: { status: "needs_auth" } }] });
  expect(text()).toContain(t("mcp.readiness_credentials"));
  expect(root().findAllByType("button").filter((button) => button.children.includes(t("mcp.connect")))).toHaveLength(0);
  await update({ connectors: [{ ...connector, status: { status: "connected" } }] });
  expect(text()).toContain(t("mcp.status_connected"));
  expect(text()).not.toContain(t("mcp.readiness_token_hint"));
});

for (const source of ["public", "organization", "personal"] as const) {
  test(`${source} exposes Add and Search; custom creation navigates only after success`, async () => {
    const pending = deferred();
    const change = mock(noop);
    const add = mock(() => pending.promise);
    await render({ source, onSourceChange: change, onAddConnector: add });
    expect(root().findByType(CatalogHeader).props.search).toBeDefined();
    expect(root().findAllByType("div").filter((node) => node.props.className?.includes("min-h-[20rem]"))).toHaveLength(1);
    await openAdd();
    expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
    await click(t("common.create"));
    expect(add).toHaveBeenCalledWith("custom", { type: "remote", url: "https://custom.example/mcp" });
    expect(change).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
    expect(change.mock.calls).toEqual([["personal"]]);
    expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
}

test("cancel and failed custom creation do not change source", async () => {
  const change = mock(noop);
  const add = mock(() => Promise.reject(new Error("Creation failed")));
  await render({ onSourceChange: change, onAddConnector: add });
  await openAdd();
  await click(t("common.cancel"));
  expect(change).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  await openAdd();
  await click(t("common.create"));
  expect(text()).toContain("Creation failed");
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(change).not.toHaveBeenCalled();
});

test("public directory stays public after success and rejected or thrown failures", async () => {
  const pending = deferred();
  const change = mock(noop);
  await render({ onSourceChange: change, onConnectDirectory: () => pending.promise });
  await click(t("project_extensions.connect"));
  expect(change).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(); });
  expect(change).not.toHaveBeenCalled();
  await update({ onConnectDirectory: () => Promise.reject(new Error("Install failed")) });
  await click(t("project_extensions.connect"));
  await update({ onConnectDirectory: () => { throw new Error("Install failed"); } });
  await click(t("project_extensions.connect"));
  expect(change).not.toHaveBeenCalled();
});

for (const operation of ["custom", "directory"] as const) {
  for (const invalidation of ["unmount", "source", "manual", "organization", "write-context", "navigation-context"] as const) {
    test(`${operation} ignores late success after ${invalidation} changes`, async () => {
      const pending = deferred();
      const change = mock(noop);
      const nextChange = mock(noop);
      await render({ onSourceChange: change, onAddConnector: () => pending.promise, onConnectDirectory: () => pending.promise });
      if (operation === "custom") {
        await openAdd();
        await click(t("common.create"));
      } else {
        await click(t("project_extensions.connect"));
      }
      if (invalidation === "unmount") await unmount();
      if (invalidation === "source") {
        await update({ source: "organization" });
        await update({ source: "public" });
      }
      if (invalidation === "manual") {
        // Invalidate synchronously, even before a controlled parent commits its new source.
        await act(async () => {
          root().findByType(CatalogHeader).props.onSourceChange("organization");
          pending.resolve();
        });
        expect(change.mock.calls).toEqual([["organization"]]);
        return;
      }
      if (invalidation === "organization") await update({ organizationName: "Other team" });
      if (invalidation === "write-context") await update(operation === "custom" ? { onAddConnector: noop } : { onConnectDirectory: noop });
      if (invalidation === "navigation-context") await update({ onSourceChange: nextChange });
      await act(async () => { pending.resolve(); });
      expect(change).not.toHaveBeenCalled();
      expect(nextChange).not.toHaveBeenCalled();
    });
  }
}

test("query and add draft survive source changes; organization render functions receive the query", async () => {
  const organizationContent = mock((search: string) => <div>Organization query: {search}</div>);
  await render({ organizationContent });
  await fill(t("mcp.search_extensions_placeholder"), " Directory ");
  expect(text()).toContain("Directory entry");
  await openAdd();
  for (const source of ["organization", "personal", "public"] as CatalogSource[]) {
    await update({ source });
    expect(root().findByProps({ placeholder: t("mcp.search_extensions_placeholder") }).props.value).toBe(" Directory ");
    expect(root().findByProps({ placeholder: "context7" }).props.value).toBe("custom");
    expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  }
  expect(organizationContent).toHaveBeenCalledWith(" Directory ", expect.any(Function));
  await click(t("common.cancel"));
  await update({ source: "organization", organizationContent: <div>Static organization content</div> });
  expect(text()).toContain("Static organization content");
});

test("custom detail editing and removal close on source changes", async () => {
  const change = mock(noop);
  const edit = mock(noop);
  await render({ source: "personal", onSourceChange: change, onAddConnector: edit });
  const openDetail = async () => {
    await act(async () => { root().findAllByType("button").find((button) => button.props.className?.includes("text-left"))!.props.onClick(); });
  };
  await openDetail();
  await click(t("common.save"));
  expect(edit).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  await openDetail();
  await update({ source: "public" });
  await update({ source: "personal" });
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  await openDetail();
  await click(t("mcp.remove_app"));
  expect(root().findAllByProps({ "data-testid": "remove-dialog" })).toHaveLength(1);
  await update({ source: "organization" });
  await update({ source: "personal" });
  expect(root().findAllByProps({ "data-testid": "remove-dialog" })).toHaveLength(0);
  for (const source of ["public", "organization"] as const) {
    await update({ source });
    expect(text()).not.toContain("Existing");
    expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  }
});

const publicEntry: McpDirectoryInfo = {
  name: "Public connector",
  serverName: "public-server",
  description: "Public directory connector",
  type: "remote",
  url: "https://public.example/mcp",
  oauth: true,
};
const installedPublic = {
  name: "public-server",
  config: { type: "remote" as const, url: " https://public.example/mcp ", enabled: false },
};

test("Personal excludes exact public matches, including disabled connectors, but retains custom collisions", async () => {
  await render({ source: "personal", publicEntries: [publicEntry], connectors: [installedPublic, ...defaults.connectors] });
  expect(text()).not.toContain("public-server");
  expect(text()).toContain("Existing");
  await fill(t("mcp.search_extensions_placeholder"), "public");
  expect(text()).toContain(t("chat.no_search_results"));
  await update({ connectors: [{ ...installedPublic, config: { type: "remote", url: "https://custom.example/mcp" } }] });
  expect(text()).toContain("public-server");
  await update({ connectors: [installedPublic], publicEntries: [] });
  expect(text()).toContain("public-server");
});

test("public install remains Public after inventory refresh and is absent from Personal", async () => {
  const connect = mock(noop);
  const change = mock(noop);
  await render({ connectors: [], publicEntries: [publicEntry], onConnectDirectory: connect, onSourceChange: change });
  await click(t("project_extensions.connect"));
  expect(connect).toHaveBeenCalledWith(publicEntry);
  await update({ connectors: [installedPublic] });
  expect(text()).toContain(t("customization.installed"));
  expect(root().findAllByType("button").some((button) => button.children.includes(t("common.edit")))).toBe(true);
  expect(change).not.toHaveBeenCalled();
  await update({ source: "personal" });
  expect(text()).not.toContain("public-server");
});

test("installed public detail supports enable, authorization, edit and removal without changing source", async () => {
  const toggle = mock(noop);
  const authorize = mock(noop);
  let raw = formatConfigWithMcpEntry("", installedPublic.name, installedPublic.config);
  const save = mock((name: string, config: McpServerConfig) => {
    const previous = parseGlobalMcpEntries(raw).find((connector) => connector.name === name)!;
    const entry = matchPublicConnector(previous, [publicEntry])!;
    raw = formatConfigWithMcpEntry(raw, name, config, { source: "public", catalogId: entry.serverName });
  });
  const remove = mock(noop);
  const change = mock(noop);
  await render({
    publicEntries: [publicEntry], connectors: [installedPublic],
    onToggleEnabled: toggle, onAuthorize: authorize, onAddConnector: save,
    onRemoveConnector: remove, onSourceChange: change,
  });
  await click(t("common.edit"));
  await click(t("mcp.enable_app"));
  expect(toggle).toHaveBeenCalledWith("public-server", true);
  const authorizedTarget = { ...installedPublic, config: { ...installedPublic.config, enabled: true, headers: { "X-Custom": "retained" } }, status: { status: "needs_auth" as const } };
  await update({ connectors: [authorizedTarget] });
  await click(t("mcp.connect"));
  expect(authorize).toHaveBeenCalledWith(authorizedTarget);
  await click(t("mcp.disable_app"));
  expect(toggle).toHaveBeenCalledWith("public-server", false);
  const editedConfig = { ...authorizedTarget.config, url: "https://custom.example/mcp" };
  await act(async () => {
    root().findByProps({ role: "dialog" }).findByType("input").props.onChange({ currentTarget: { value: editedConfig.url } });
  });
  await click(t("common.save"));
  expect(save).toHaveBeenCalledWith("public-server", editedConfig);
  expect(change).not.toHaveBeenCalled();
  await update({ connectors: parseGlobalMcpEntries(raw) });
  expect(text()).toContain(t("customization.installed"));
  expect(text()).not.toContain(t("customization.connector_name_conflict"));
  await update({ source: "personal" });
  expect(text()).not.toContain("public-server");
  await update({ source: "public" });
  await click(t("common.edit"));
  await click(t("mcp.remove_app"));
  await click("Confirm removal");
  expect(remove).toHaveBeenCalledWith("public-server");
  expect(change).not.toHaveBeenCalled();
});

test("public name collision shows a disabled connect and hint, never installed or overwritten", async () => {
  const connect = mock(noop);
  await render({
    publicEntries: [publicEntry],
    connectors: [{ ...installedPublic, config: { type: "remote", url: "https://custom.example/mcp" } }],
    onConnectDirectory: connect,
  });
  expect(text()).not.toContain(t("customization.installed"));
  expect(text()).toContain(t("customization.connector_name_conflict"));
  expect(root().findAllByType("button").find((button) => button.children.includes(t("project_extensions.connect")))!.props.disabled).toBe(true);
  await act(async () => {
    root().findAllByType(Button).find((button) => button.props.children === t("project_extensions.connect"))!.props.onClick();
  });
  expect(connect).not.toHaveBeenCalled();
});

for (const source of ["public", "organization", "personal"] as const) {
  test(`${source} custom Add rejects any existing name, including a public connector`, async () => {
    const add = mock(noop);
    const change = mock(noop);
    await render({ source, connectors: [installedPublic, ...defaults.connectors], publicEntries: [publicEntry], onAddConnector: add, onSourceChange: change });
    await openAdd();
    for (const name of [" Existing ", "public-server"]) {
      await fill("context7", name);
      expect(text()).toContain(t("customization.connector_name_conflict"));
      expect(root().findAllByType("button").find((button) => button.children.includes(t("common.create")))!.props.disabled).toBe(true);
      await act(async () => {
        root().findAllByType(Button).find((button) => button.props.children === t("common.create"))!.props.onClick();
      });
    }
    expect(add).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  });
}

test("public detail closes if the same name is replaced by a custom endpoint", async () => {
  const save = mock(noop);
  await render({ publicEntries: [publicEntry], connectors: [installedPublic], onAddConnector: save });
  await click(t("common.edit"));
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  await update({ connectors: [{ ...installedPublic, config: { type: "remote", url: "https://custom.example/mcp" } }] });
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(save).not.toHaveBeenCalled();
});

test("stored public provenance retains directory management after endpoint and catalog server name changes", async () => {
  const save = mock(noop);
  const create = mock(noop);
  const entry = { ...publicEntry, id: "stable-public-id", serverName: "renamed-server" };
  const connector = {
    ...installedPublic, catalogSource: "public" as const, catalogId: entry.id,
    config: { ...installedPublic.config, url: "https://edited.example/mcp" },
  };
  await render({ publicEntries: [entry], connectors: [connector], onAddConnector: save, onCreateConnector: create });
  expect(text()).toContain(t("customization.installed"));
  expect(text()).not.toContain(t("customization.connector_name_conflict"));
  await click(t("common.edit"));
  expect(root().findByProps({ role: "dialog" }).findByType("input").props.value).toBe(connector.config.url);
  await update({ publicEntries: [] });
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  await click(t("common.save"));
  expect(save).toHaveBeenCalledWith(connector.name, connector.config);
  expect(create).not.toHaveBeenCalled();
  await update({ source: "personal" });
  expect(text()).not.toContain(connector.name);
});

test("public cards search installed names, URLs and commands after catalog identity changes", async () => {
  const entry = { ...publicEntry, id: "stable-id", serverName: "renamed-server" };
  const connector = {
    ...installedPublic, catalogSource: "public" as const, catalogId: entry.id,
    config: { type: "remote" as const, url: "https://edited.example/mcp" },
  };
  await render({ publicEntries: [entry], connectors: [connector] });
  for (const query of [connector.name, " EDITED.EXAMPLE ", entry.serverName, entry.description]) {
    await fill(t("mcp.search_extensions_placeholder"), query);
    expect(text()).toContain(t("customization.installed"));
    await click(t("common.edit"));
    expect(root().findByProps({ role: "dialog" }).findByType("input").props.value).toBe(connector.config.url);
    await click(t("common.save"));
  }
  await update({ connectors: [{ ...connector, config: { type: "local", command: ["node", "saved-tool.js", "--custom-argument"] } }] });
  for (const query of ["saved-tool.js", "--custom-argument"]) {
    await fill(t("mcp.search_extensions_placeholder"), query);
    expect(text()).toContain(t("customization.installed"));
  }
  await fill(t("mcp.search_extensions_placeholder"), "missing");
  expect(text()).not.toContain(t("customization.installed"));
  expect(text()).toContain(t("chat.no_search_results"));
  await update({ connectors: [{ ...connector, catalogSource: "personal" }] });
  await fill(t("mcp.search_extensions_placeholder"), "edited.example");
  expect(text()).not.toContain(entry.description);
});

test("custom creation still navigates when only the inventory-dependent edit callback changes", async () => {
  const pending = deferred();
  const change = mock(noop);
  await render({ onCreateConnector: () => pending.promise, onSourceChange: change });
  await openAdd();
  await click(t("common.create"));
  await update({ onAddConnector: mock(noop), connectors: [...defaults.connectors, {
    name: "custom", config: { type: "remote", url: "https://custom.example/mcp" }, catalogSource: "personal",
  }] });
  await act(async () => { pending.resolve(); });
  expect(change).toHaveBeenCalledWith("personal");
});

test("a stale public catalog ID remains an orphan instead of claiming a same-name directory entry", async () => {
  const connector = { ...installedPublic, catalogSource: "public" as const, catalogId: "old-id" };
  await render({ publicEntries: [{ ...publicEntry, id: "new-id" }], connectors: [connector] });
  expect(text()).toContain(connector.name);
  expect(text()).toContain(t("customization.installed"));
  expect(text()).toContain(t("customization.connector_name_conflict"));
  expect(root().findAllByType("button").find((button) => button.children.includes(t("project_extensions.connect")))!.props.disabled).toBe(true);
  await act(async () => { root().findAllByType("button").find((button) => button.props.className?.includes("text-left"))!.props.onClick(); });
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
});

test("orphaned public connectors remain searchable and fully manageable without directory entries", async () => {
  const connector = {
    ...installedPublic, catalogSource: "public" as const, catalogId: "removed-id",
    config: { type: "remote" as const, url: "https://orphan.example/mcp" },
    status: { status: "needs_auth" as const },
  };
  const save = mock(noop);
  const toggle = mock(noop);
  const authorize = mock(noop);
  const remove = mock(noop);
  await render({
    publicEntries: [], connectors: [connector], onAddConnector: save,
    onToggleEnabled: toggle, onAuthorize: authorize, onRemoveConnector: remove,
  });
  expect(text()).toContain(connector.name);
  expect(text()).toContain(t("customization.installed"));
  expect(text()).not.toContain(t("chat.no_search_results"));
  await fill(t("mcp.search_extensions_placeholder"), "missing");
  expect(text()).not.toContain(connector.name);
  await fill(t("mcp.search_extensions_placeholder"), "orphan.example");
  const openOrphan = async () => {
    await act(async () => { root().findAllByType("button").find((button) => button.props.className?.includes("text-left"))!.props.onClick(); });
  };
  await openOrphan();
  await click(t("mcp.connect"));
  expect(authorize).toHaveBeenCalledWith(connector);
  await click(t("mcp.disable_app"));
  expect(toggle).toHaveBeenCalledWith(connector.name, false);
  await click(t("common.save"));
  expect(save).toHaveBeenCalledWith(connector.name, connector.config);
  await openOrphan();
  await click(t("mcp.remove_app"));
  await click("Confirm removal");
  expect(remove).toHaveBeenCalledWith(connector.name);
  await update({ source: "personal" });
  expect(text()).not.toContain(connector.name);
  await update({ source: "organization" });
  expect(text()).not.toContain(connector.name);
});

for (const source of ["public", "organization", "personal"] as const) {
  test(`${source} custom creation uses the separate callback and exact catalog copies remain Personal`, async () => {
    const create = mock(noop);
    const edit = mock(noop);
    const change = mock(noop);
    await render({ source, connectors: [], publicEntries: [publicEntry], onCreateConnector: create, onAddConnector: edit, onSourceChange: change });
    await openAdd();
    await fill("context7", installedPublic.name);
    await fill("https://example.com/mcp", publicEntry.url!);
    await click(t("common.create"));
    const config = { type: "remote" as const, url: publicEntry.url! };
    expect(create).toHaveBeenCalledWith(installedPublic.name, config);
    expect(edit).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledWith("personal");
    // The creation callback persists provenance and the parent returns it in inventory.
    await update({ source: "personal", connectors: [{ name: installedPublic.name, config, catalogSource: "personal" }] });
    expect(text()).toContain(installedPublic.name);
    await update({ source: "public" });
    expect(text()).not.toContain(t("customization.installed"));
    expect(text()).toContain(t("customization.connector_name_conflict"));
    expect(root().findAllByType("button").find((button) => button.children.includes(t("project_extensions.connect")))!.props.disabled).toBe(true);
  });
}

test("custom creation callback failure and replacement cannot redirect", async () => {
  const change = mock(noop);
  const edit = mock(noop);
  await render({ onCreateConnector: () => Promise.reject(new Error("Create rejected")), onAddConnector: edit, onSourceChange: change });
  await openAdd();
  await click(t("common.create"));
  expect(text()).toContain("Create rejected");
  expect(edit).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  const pending = deferred();
  await update({ onCreateConnector: () => pending.promise });
  await click(t("common.create"));
  await update({ onCreateConnector: noop });
  await act(async () => { pending.resolve(); });
  expect(change).not.toHaveBeenCalled();
});

const pages = () => root().findAllByProps({ "data-testid": "detail-page" });
async function card(name: string) {
  await act(async () => {
    root().findAllByType("button").find((button) => button.props.className?.includes("text-left")
      && button.findAll((node) => node.children.includes(name)).length)!.props.onClick();
  });
}

test("page public overview is read-only until explicit install, then uses live config without duplicating the card", async () => {
  const entry = { ...publicEntry, id: "directory-id" };
  const connect = mock(noop);
  const save = mock(noop);
  const toggle = mock(noop);
  await render({ detailPresentation: "page", connectors: [], publicEntries: [entry], onConnectDirectory: connect, onAddConnector: save, onToggleEnabled: toggle });
  await fill(t("mcp.search_extensions_placeholder"), "Public");
  await card(entry.name);
  expect(pages()).toHaveLength(1);
  expect(text()).toContain(entry.description);
  expect(root().findAllByType(CatalogHeader)).toHaveLength(0);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(root().findAllByType("input")).toHaveLength(0);
  expect(connect).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  await click(t("project_extensions.connect"));
  expect(connect).toHaveBeenCalledWith(entry);
  const connector = { ...installedPublic, catalogSource: "public" as const, catalogId: entry.id, config: { ...installedPublic.config, url: "https://edited.example/mcp", headers: { "X-Custom": "keep" } } };
  await update({ connectors: [connector] });
  expect(root().findByType("input").props.value).toBe(connector.config.url);
  expect(root().findAllByType("button").some((button) => button.children.includes(t("project_extensions.connect")))).toBe(false);
  await click(t("settings.tab_connectors"));
  expect(root().findByProps({ placeholder: t("mcp.search_extensions_placeholder") }).props.value).toBe("Public");
  expect(root().findAllByType("button").filter((button) => button.props.className?.includes("text-left"))).toHaveLength(1);
  await card(entry.name);
  expect(root().findByType("h1").children).toEqual([connector.name]);
  expect(root().findByType("input").props.value).toBe(connector.config.url);
  await click(t("settings.tab_connectors"));
  const request = { id: `global-connector:${connector.name}`, nonce: 1 };
  await update({ detailRequest: request });
  expect(root().findByType("h1").children).toEqual([connector.name]);
  expect(root().findByType("input").props.value).toBe(connector.config.url);
  expect(text()).toContain(entry.description);
  expect(save).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  await click(t("settings.tab_connectors"));
  await update({ detailRequest: { ...request }, connectors: [{ ...connector }] });
  expect(pages()).toHaveLength(0);
  await update({ detailRequest: { ...request, nonce: 2 } });
  expect(pages()).toHaveLength(1);
  await update({ source: "personal" });
  expect(pages()).toHaveLength(0);
  expect(text()).not.toContain(connector.name);
  await update({ source: "public" });
  expect(pages()).toHaveLength(0);
});

test.each(["directory-id", "public-server"])("directory request %s waits for inventory and opens overview without installing", async (id) => {
  const entry = { ...publicEntry, ...(id === "directory-id" ? { id } : {}) };
  const connect = mock(noop);
  await render({ detailPresentation: "page", connectors: [], publicEntries: [], detailRequest: { id, nonce: 1 }, onConnectDirectory: connect });
  expect(pages()).toHaveLength(0);
  await update({ publicEntries: [entry] });
  expect(pages()).toHaveLength(1);
  expect(root().findByType("h1").children).toEqual([entry.name]);
  expect(connect).not.toHaveBeenCalled();
});

test("page collision overview cannot overwrite Personal connectors", async () => {
  const connect = mock(noop);
  await render({ detailPresentation: "page", publicEntries: [publicEntry], connectors: [{ ...installedPublic, catalogSource: "personal" }], onConnectDirectory: connect });
  await card(publicEntry.name);
  expect(pages()).toHaveLength(1);
  expect(text()).toContain(t("customization.connector_name_conflict"));
  const install = root().findAllByType("button").find((button) => button.children.includes(t("project_extensions.connect")))!;
  expect(install.props.disabled).toBe(true);
  await act(async () => root().findAllByType(Button).find((button) => button.props.children === t("project_extensions.connect"))!.props.onClick());
  expect(connect).not.toHaveBeenCalled();
});

test("Personal page editing preserves drafts on refresh and config fields on save; Add and Remove remain dialogs", async () => {
  const connector = { name: "local", config: { type: "local" as const, command: ["node", "tool with spaces.js"], environment: { KEEP: "value" }, enabled: false } };
  const save = mock(noop);
  const remove = mock(noop);
  await render({ source: "personal", detailPresentation: "page", connectors: [connector], onAddConnector: save, onRemoveConnector: remove });
  await card(connector.name);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(JSON.parse(root().findByType("textarea").props.value)).toEqual(connector.config.command);
  await act(async () => root().findByType("textarea").props.onChange({ currentTarget: { value: "not an array" } }));
  expect(root().findAllByType("button").find((button) => button.children.includes(t("common.save")))!.props.disabled).toBe(true);
  await act(async () => root().findAllByType(Button).find((button) => button.props.children === t("common.save"))!.props.onClick());
  expect(save).not.toHaveBeenCalled();
  await act(async () => root().findByType("textarea").props.onChange({ currentTarget: { value: '["node", "edited.js"]' } }));
  await update({ connectors: [{ ...connector, config: { ...connector.config, environment: { KEEP: "latest" } }, status: { status: "connected" } }] });
  expect(root().findByType("textarea").props.value).toBe('["node", "edited.js"]');
  await click(t("common.save"));
  expect(save).toHaveBeenCalledWith("local", { ...connector.config, command: ["node", "edited.js"], environment: { KEEP: "latest" } });
  expect(pages()).toHaveLength(0);
  await update({ detailRequest: { id: "local", nonce: 1 } });
  await click(t("mcp.remove_app"));
  expect(root().findAllByProps({ "data-testid": "remove-dialog" })).toHaveLength(1);
  expect(remove).not.toHaveBeenCalled();
  await click("Confirm removal");
  expect(remove).toHaveBeenCalledWith("local");
  await openAdd();
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
});

test("organization cards and raw connection requests use the parent's inline detail renderer", async () => {
  const organizationDetail = mock((id: string) => id === "connection-id" ? { name: "Team connector", description: "Team description", content: <div>Parent-owned controls</div> } : null);
  const save = mock(noop);
  await render({
    source: "organization", detailPresentation: "page", organizationDetail, onAddConnector: save,
    organizationContent: (search, openDetail) => <button onClick={() => openDetail("connection-id")}>Team card {search}</button>,
  });
  await click("Team card ");
  expect(pages()).toHaveLength(1);
  expect(text()).toContain("Parent-owned controls");
  expect(text()).toContain("Team description");
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(root().findAllByType("input")).toHaveLength(0);
  await click(t("settings.tab_connectors"));
  await update({ detailRequest: { id: "connection-id", nonce: 1 } });
  expect(pages()).toHaveLength(1);
  expect(root().findByType("h1").children).toEqual(["Team connector"]);
  expect(text()).toContain("Parent-owned controls");
  expect(text()).toContain("Team description");
  expect(organizationDetail).toHaveBeenCalledWith("connection-id");
  expect(save).not.toHaveBeenCalled();
  await update({ source: "personal" });
  expect(pages()).toHaveLength(0);
  await update({ source: "organization" });
  expect(pages()).toHaveLength(0);
});

test.each(["resolve", "reject"] as const)("late save %s cannot close or contaminate the next page detail", async (outcome) => {
  const pending = deferred();
  const second = { name: "second", config: { type: "remote" as const, url: "https://second.example/mcp" } };
  await render({ source: "personal", detailPresentation: "page", connectors: [...defaults.connectors, second], onAddConnector: () => pending.promise });
  await card("Existing");
  await click(t("common.save"));
  await update({ detailRequest: { id: "global-connector:second", nonce: 1 } });
  await act(async () => outcome === "resolve" ? pending.resolve() : pending.reject(new Error("Old save failure")));
  expect(root().findByType("h1").children).toEqual(["second"]);
  expect(root().findByType("input").props.value).toBe(second.config.url);
  expect(text()).not.toContain("Old save failure");
});

test.each(["global-connector:public-server", "public-server", "stable-id"])("installed request %s opens the current editor, not the directory template", async (id) => {
  const entry = { ...publicEntry, id: "stable-id", serverName: "renamed-server" };
  const connector = {
    ...installedPublic, catalogSource: "public" as const, catalogId: entry.id,
    config: { type: "remote" as const, url: "https://current.example/mcp", headers: { "X-Custom": "retained" } },
    status: { status: "needs_auth" as const },
  };
  const authorize = mock(noop);
  const toggle = mock(noop);
  const save = mock(() => Promise.reject(new Error("Save rejected")));
  await render({
    detailPresentation: "page", publicEntries: [entry], connectors: [], busy: true,
    detailRequest: { id, nonce: 1 }, onAuthorize: authorize, onToggleEnabled: toggle, onAddConnector: save,
  });
  expect(pages()).toHaveLength(0);
  await update({ busy: false, connectors: [connector] });
  expect(root().findByType("h1").children).toEqual([connector.name]);
  expect(root().findByType("input").props.value).toBe(connector.config.url);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  await click(t("mcp.connect"));
  expect(authorize).toHaveBeenCalledWith(connector);
  await click(t("mcp.disable_app"));
  expect(toggle).toHaveBeenCalledWith(connector.name, false);
  await act(async () => root().findByType("input").props.onChange({ currentTarget: { value: "https://draft.example/mcp" } }));
  await click(t("common.save"));
  expect(save).toHaveBeenCalledWith(connector.name, { ...connector.config, url: "https://draft.example/mcp" });
  expect(pages()).toHaveLength(1);
  expect(text()).toContain("Save rejected");
  expect(root().findByType("input").props.value).toBe("https://draft.example/mcp");
  await update({ publicEntries: [] });
  expect(pages()).toHaveLength(1);
  expect(root().findByType("input").props.value).toBe("https://draft.example/mcp");
});
