/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { MarketplacePackageRow } from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";
import { resolveMarketplacePluginLifecycle } from "../src/react-app/domains/settings/pages/marketplace-plugin-state";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: box,
  DialogHeader: box,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: box,
  DialogFooter: box,
}));
mock.module("../src/components/ui/scroll-area", () => ({ ScrollArea: box, ScrollAreaViewport: box, ScrollAreaContent: box }));
mock.module("../src/react-app/domains/session/surface/markdown", () => ({ MarkdownBlock: () => null }));
const { ExtensionDetailModal } = await import("../src/react-app/design-system/extension-detail-modal");
const { MarketplacePackageDetailModal } = await import("../src/react-app/domains/settings/pages/marketplace-package-detail-modal");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
const noop = () => {};
async function render(node: ReactNode) {
  await act(async () => { renderer = TestRenderer.create(node); });
}
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });

describe("Plugin detail presentation", () => {
  test.each([undefined, "page"] as const)("extension %s keeps configuration and two-step removal without duplicating page titles", async (presentation) => {
    const remove = mock(noop);
    const close = mock(noop);
    await render(<ExtensionDetailModal open presentation={presentation} onClose={close} name="Example" description="Description" configSlot={<div>Configuration</div>} onRemove={remove} />);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(presentation === "page" ? 0 : 1);
    expect(renderer.root.findAllByType("h2")).toHaveLength(presentation === "page" ? 0 : 1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Configuration");
    const removeButton = () => renderer.root.findAllByType("button").find((button) => button.children.includes("Remove") || button.children.includes("Confirm remove"))!;
    await act(async () => removeButton().props.onClick());
    expect(remove).not.toHaveBeenCalled();
    await act(async () => removeButton().props.onClick());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("closed page extension bodies do not render", async () => {
    await render(<ExtensionDetailModal open={false} presentation="page" onClose={noop} name="Example" description="Description" />);
    expect(renderer.toJSON()).toBeNull();
  });

  test.each([undefined, "page"] as const)("marketplace %s shares lifecycle content and retains mutation gates", async (presentation) => {
    const plugin = { id: "example", name: "Example", description: "Description", status: "active", memberCount: 0, componentCounts: {} };
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin,
      imported: null,
      components: [{ configObjectId: "local-mcp", serverName: "local", delivery: "desktop", command: ["example"] }],
    });
    const row: MarketplacePackageRow = {
      source: "cloud", marketplaceId: "collection", marketplaceName: "Collection", sourceMarketplaceId: "collection",
      plugin, imported: null, item: null, status: "available", counts: [], composition: [], mcpComponents: [], delivery: null, lifecycle, searchableText: "Example",
    };
    const install = mock(noop);
    await render(<MarketplacePackageDetailModal presentation={presentation} row={row} lifecycle={lifecycle} resolved={null} resolutionState="current" resolveError={null} orgMcpConnections={[]} orgMcpConnectingId={null} onClose={noop} onOpenAccount={noop} onRemovePlugin={noop} onInstallPlugin={install} onRetryResolve={noop} accessHint="Read only" canMutate={false} />);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(presentation === "page" ? 0 : 1);
    expect(renderer.root.findAllByType("h2")).toHaveLength(presentation === "page" ? 0 : 1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Read only");
    expect(renderer.root.findAllByType("button").some((button) => button.props.disabled)).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });

  test("plugin detail keeps non-MCP package components visible", async () => {
    const plugin = { id: "example", name: "Example", description: "Description", status: "active", memberCount: 0, componentCounts: { skill: 1 } };
    const object = { id: "skill-1", objectType: "skill", title: "Review skill", description: null, currentRelativePath: null, status: "active", updatedAt: null, latestVersion: { id: "v1", rawSourceText: "# Review", normalizedPayloadJson: null, sourceRevisionRef: null, createdAt: null } };
    const resolved = { plugin, memberships: [{ id: "membership-1", pluginId: plugin.id, configObjectId: object.id, configObject: object }] };
    const lifecycle = resolveMarketplacePluginLifecycle({ plugin, imported: null, components: [], resolvedConfigObjectIds: [object.id] });
    const row: MarketplacePackageRow = {
      source: "cloud", marketplaceId: "collection", marketplaceName: "Collection", sourceMarketplaceId: "collection",
      plugin, imported: null, item: null, status: "available", counts: [], composition: [], mcpComponents: [], delivery: null, lifecycle, searchableText: "Example",
    };
    await render(<MarketplacePackageDetailModal presentation="page" row={row} lifecycle={lifecycle} resolved={resolved as never} resolutionState="current" resolveError={null} orgMcpConnections={[]} orgMcpConnectingId={null} onClose={noop} onOpenAccount={noop} onRemovePlugin={noop} onInstallPlugin={noop} onRetryResolve={noop} canMutate={false} />);
    expect(JSON.stringify(renderer.toJSON())).toContain("Review skill");
  });
});
