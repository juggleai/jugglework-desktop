/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { t } from "../src/i18n";
import type { GlobalConnectorsViewProps } from "../src/react-app/domains/settings/pages/global-connectors-view";
import { CatalogHeader, type CatalogSource } from "../src/react-app/domains/settings/pages/catalog-source";

mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module("../src/react-app/design-system/modals/confirm-modal", () => ({
  ConfirmModal: ({ open }: { open: boolean }) => open ? <div data-testid="remove-dialog" /> : null,
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

test("public directory navigates after success but not rejected or thrown failures", async () => {
  const pending = deferred();
  const change = mock(noop);
  await render({ onSourceChange: change, onConnectDirectory: () => pending.promise });
  await click(t("project_extensions.connect"));
  expect(change).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(); });
  expect(change.mock.calls).toEqual([["personal"]]);
  change.mockClear();
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
  expect(organizationContent).toHaveBeenCalledWith(" Directory ");
  await click(t("common.cancel"));
  await update({ source: "organization", organizationContent: <div>Static organization content</div> });
  expect(text()).toContain("Static organization content");
});

test("detail editing and removal remain personal and close on source changes", async () => {
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
