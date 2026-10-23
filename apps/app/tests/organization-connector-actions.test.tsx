/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { DenExternalMcpConnection } from "../src/app/lib/den";
import { t } from "../src/i18n";
import { OrganizationConnectorCard, OrganizationConnectorAction } from "../src/react-app/domains/settings/pages/organization-connector-card";
import { CatalogDetailPage } from "../src/react-app/domains/settings/pages/catalog-detail-page";
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
const { GlobalConnectorsView } = await import("../src/react-app/domains/settings/pages/global-connectors-view");
const github: DenExternalMcpConnection = { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", credentialMode: "per_member", connected: false, connectedForMe: false, connectedAt: null };
const noop = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; });

test("card navigation and Connect/Disconnect are separate buttons and reflect current account state", async () => {
  const open = mock(noop), connect = mock(noop), disconnect = mock(noop);
  const card = (connection = github) => <OrganizationConnectorCard connection={connection} canManageShared={false} onOpenDetail={open} onConnect={connect} onDisconnect={disconnect} />;
  await act(async () => { view = TestRenderer.create(card()); });
  const action = () => view!.root.findAllByType("button").find((button) => button.props["data-testid"] === "org-connector-action:github")!;
  expect(action().children).toContain(t("mcp.connect"));
  await act(async () => { view!.root.findByProps({ "data-testid": "org-connector-open:github" }).props.onClick(); });
  expect(open).toHaveBeenCalledTimes(1); expect(connect).not.toHaveBeenCalled();
  expect(view!.root.findAllByType("button").every((button) => button.findAllByType("button").length === 1)).toBe(true);
  await act(async () => { action().props.onClick(); });
  expect(connect).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
  await act(async () => { view!.update(card({ ...github, connectedForMe: true })); });
  expect(action().children).toContain(t("mcp.org_connection_disconnect_action"));
  await act(async () => { action().props.onClick(); });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test("organization inline detail exposes the action in its header and updates after disconnect", async () => {
  const connect = mock(noop), disconnect = mock(noop);
  let connection = github;
  const action = () => <OrganizationConnectorAction connection={connection} canManageShared={true} onConnect={connect} onDisconnect={disconnect} />;
  const tree = () => <GlobalConnectorsView source="organization" detailPresentation="page" busy={false} connectors={[]} unconnected={[]}
    onAddConnector={noop} onConnectDirectory={noop} onToggleEnabled={noop} onAuthorize={noop} onRemoveConnector={noop} onRefresh={noop}
    organizationDetail={() => ({ name: "GitHub", content: <p>GitHub details</p>, actions: action() })}
    organizationContent={(_query, openDetail) => <button onClick={() => openDetail("github")}>Open GitHub detail</button>} />;
  await act(async () => { view = TestRenderer.create(tree()); });
  await act(async () => { view!.root.findAllByType("button").find((button) => button.children.includes("Open GitHub detail"))!.props.onClick(); });
  expect(view!.root.findAllByType(CatalogDetailPage)).toHaveLength(1);
  const button = () => view!.root.findByType("header").findByType("button");
  expect(button().children).toContain(t("mcp.connect"));
  await act(async () => { button().props.onClick(); }); expect(connect).toHaveBeenCalledTimes(1);
  connection = { ...github, connectedForMe: true };
  await act(async () => { view!.update(tree()); });
  expect(button().children).toContain(t("mcp.org_connection_disconnect_action"));
  await act(async () => { button().props.onClick(); }); expect(disconnect).toHaveBeenCalledTimes(1);
  connection = github;
  await act(async () => { view!.update(tree()); });
  expect(button().children).toContain(t("mcp.connect"));
});

test("shared actions respect administrator management and show pending state", async () => {
  const action = (canManageShared: boolean, disconnecting = false) => <OrganizationConnectorAction connection={{ ...github, credentialMode: "shared", connected: true }} canManageShared={canManageShared} disconnecting={disconnecting} onConnect={noop} onDisconnect={noop} />;
  await act(async () => { view = TestRenderer.create(action(false)); });
  expect(view!.root.findByType("button").props.disabled).toBe(true);
  await act(async () => { view!.update(action(true)); });
  expect(view!.root.findByType("button").props.disabled).toBe(false);
  await act(async () => { view!.update(action(true, true)); });
  expect(view!.root.findByType("button").props.disabled).toBe(true);
  expect(view!.root.findByType("button").children).toContain(t("mcp.org_connection_disconnecting_action"));
});
