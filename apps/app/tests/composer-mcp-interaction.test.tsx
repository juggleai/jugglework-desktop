/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { McpServerEntry, McpStatusMap } from "../src/app/types";
import { t } from "../src/i18n";
import { selectComposerInstalledMcpEntries } from "../src/react-app/domains/connections/workspace-mcp-inventory";

// Keep the actual composer handlers while isolating editor, policy and model services.
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
const extensionState = await import("../src/react-app/domains/settings/extension-state");
mock.module("../src/react-app/domains/session/surface/composer/editor", () => ({ LexicalPromptEditor: () => null }));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ ...desktopConfig, useDesktopRestriction: () => false }));
mock.module("../src/react-app/domains/settings/extension-state", () => ({
  ...extensionState,
  isJuggleWorkExtensionEnabled: () => false,
  isJuggleWorkExtensionHidden: () => true,
  JUGGLEWORK_EXTENSION_STATE_CHANGED: "test:extensions",
}));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/model-behavior-select", () => ({ ModelBehaviorSelect: () => null }));
mock.module("../src/react-app/domains/session/surface/composer/context-usage", () => ({ ContextUsage: () => null }));
mock.module("../src/components/ui/tooltip", () => {
  const PassThrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Tooltip: PassThrough, TooltipTrigger: PassThrough, TooltipContent: PassThrough, TooltipProvider: PassThrough };
});

const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
type Props = ComponentProps<typeof ReactSessionComposer>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const noop = () => {};
const emptyList = async () => [];
let renderer: TestRenderer.ReactTestRenderer;
let props: Props;
afterEach(async () => { await act(async () => renderer?.unmount()); });

async function render(overrides: Partial<Props> = {}) {
  props = {
    sessionId: "synthetic-session", focusEligible: false, draft: "", mentions: {},
    createVoiceRealtimeSession: null, getVoiceRealtimeStatus: null,
    onDraftChange: mock(noop), onSend: noop, onSteer: noop, onQueue: noop, onStop: noop,
    busy: false, steering: false, submissionPreparing: false, submissionPreparingLabel: null,
    submissionDisabled: false, queuedCount: 0, disabled: false, statusLabel: "", modelPickerOpen: false,
    selectedModel: { providerID: "test", modelID: "test" },
    contextUsageMessages: [], contextUsageTranscript: [], contextWindowTokens: 0,
    onModelPickerOpenChange: noop, onModelChange: noop,
    attachments: [], onAttachFiles: noop, onRemoveAttachment: noop, attachmentsEnabled: true, attachmentsDisabledReason: null,
    imageGenerationModels: [], imageGenerationLoading: false, imageGeneration: null,
    onEnableImageGeneration: noop, onImageGenerationChange: noop, onDisableImageGeneration: noop, onRefreshImageGenerationModels: noop,
    videoGenerationModels: [], videoGenerationLoading: false, videoGeneration: null,
    onEnableVideoGeneration: noop, onVideoGenerationChange: noop, onDisableVideoGeneration: noop, onRefreshVideoGenerationModels: noop,
    modelVariantLabel: "", modelVariant: null, onModelVariantChange: noop,
    agentLabel: "", selectedAgent: null, listAgents: emptyList, onSelectAgent: noop,
    listCommands: emptyList, recentFiles: [], searchFiles: emptyList, onInsertMention: mock(noop), onRegisterCapability: mock(noop),
    onPasteText: noop, onUnsupportedFileLinks: noop, pastedText: [], onExpandPastedText: noop, onRemovePastedText: noop,
    isRemoteWorkspace: false, isSandboxWorkspace: false,
    ...overrides,
  };
  await act(async () => { renderer = TestRenderer.create(<ReactSessionComposer {...props} />); });
  await act(async () => { renderer.root.findByProps({ "aria-haspopup": "menu" }).props.onClick(); });
}

const rows = () => renderer.root.findAllByProps({ role: "menuitem" });
const row = (name: string) => rows().find((item) => item.findAllByType("span").some((span) => span.children.includes(name)))!;
async function key(key: string) {
  await act(async () => {
    renderer.root.findAllByType("div").find((node) => node.props.onKeyDownCapture)!.props.onKeyDownCapture({
      key, nativeEvent: {}, preventDefault: noop,
    });
  });
}

test("installed unavailable connectors show safe reasons and reject mouse, Enter and Tab activation", async () => {
  const statuses: McpStatusMap = {
    ready: { status: "connected" }, auth: { status: "needs_auth" },
    registration: { status: "needs_client_registration", error: "synthetic-private-detail" },
    failed: { status: "failed", error: "synthetic-private-detail" }, disabled: { status: "disabled" },
    "config-off": { status: "connected" }, "workspace-off": { status: "connected" },
    missing: { status: "not_installed" }, setup: { status: "not_configured" },
  };
  const servers: McpServerEntry[] = [...Object.keys(statuses), "pending"].map((name) => ({
    name, source: "config.global", workspaceEnabled: name !== "workspace-off",
    config: { type: "remote", enabled: name !== "config-off", url: "https://synthetic-private-url.example/mcp" },
  }));
  servers.push({ name: "uninstalled", origin: "local", config: { type: "remote" } });
  await render({ mcpServers: selectComposerInstalledMcpEntries(servers), mcpStatuses: statuses });
  expect(row("uninstalled")).toBeUndefined();
  expect(JSON.stringify(renderer.toJSON())).not.toContain("synthetic-private");
  for (const entry of servers.filter((entry) => entry.name !== "ready" && entry.name !== "uninstalled")) {
    const button = row(entry.name);
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBeTruthy();
    // Direct invocation also verifies the guard behind native disabled buttons.
    await act(async () => { button.props.onClick(); button.props.onMouseEnter(); });
    await key("Enter");
    await key("Tab");
  }
  expect(props.onDraftChange).not.toHaveBeenCalled();
  expect(props.onRegisterCapability).not.toHaveBeenCalled();
  expect(props.onInsertMention).not.toHaveBeenCalled();
  expect(row("failed").props.title).toBe(t("mcp.readiness_disconnected"));
  expect(row("workspace-off").props.title).toBe(t("connect.workspace_disabled_here"));
  expect(row("ready").props.disabled).toBe(false);
  await act(async () => { row("ready").props.onClick(); });
  expect(props.onRegisterCapability).toHaveBeenCalledTimes(1);
});

for (const activation of ["click", "Enter", "Tab"] as const) {
  test(`management works with an empty inventory via ${activation}`, async () => {
    const open = mock(noop);
    await render({ onOpenSettings: open });
    expect(JSON.stringify(renderer.toJSON())).toContain(t("composer.plus_menu_no_mcp"));
    const manage = row(t("composer.plus_menu_manage_connectors"));
    expect(manage.props.disabled).toBe(false);
    if (activation === "click") {
      await act(async () => { manage.props.onClick(); });
    } else {
      // The management action is the last row in the shared keyboard order.
      await key("ArrowUp");
      await key(activation);
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
  });
}

test("no management action is rendered without a settings callback", async () => {
  await render();
  expect(row(t("composer.plus_menu_manage_connectors"))).toBeUndefined();
});

test("failed inventory refresh keeps known installed rows but clears stale readiness", async () => {
  await render({
    mcpServers: [{ name: "known", source: "config.global", config: { type: "remote" } }],
    mcpStatuses: { known: { status: "connected" } },
    listMcp: async () => { throw new Error("synthetic-private-detail"); },
  });
  expect(row("known").props.disabled).toBe(true);
  expect(row("known").props.title).toBe(t("mcp.readiness_pending_hint"));
  await act(async () => { row("known").props.onClick(); });
  expect(props.onRegisterCapability).not.toHaveBeenCalled();
});

for (const activation of ["Enter", "Tab"] as const) {
  test(`live readiness changes guard ${activation} without hiding the installed row`, async () => {
    await render({
      mcpServers: [{ name: "changing", source: "config.project", config: { type: "remote" } }],
      mcpStatuses: { changing: { status: "connected" } },
    });
    await key("ArrowUp");
    props = { ...props, mcpStatuses: { changing: { status: "needs_auth" } } };
    await act(async () => { renderer.update(<ReactSessionComposer {...props} />); });
    expect(row("changing").props.disabled).toBe(true);
    await key(activation);
    expect(props.onRegisterCapability).not.toHaveBeenCalled();
    props = { ...props, mcpStatuses: { changing: { status: "connected" } } };
    await act(async () => { renderer.update(<ReactSessionComposer {...props} />); });
    expect(row("changing").props.disabled).toBe(false);
    await key(activation);
    expect(props.onRegisterCapability).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
  });
}
