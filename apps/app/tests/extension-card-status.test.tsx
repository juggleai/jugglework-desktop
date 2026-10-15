/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { ExtensionCard } from "../src/react-app/design-system/extension-card";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });

test("icon-only status marks enabled plugins without rendering enabled text", async () => {
  await act(async () => { renderer = TestRenderer.create(<ExtensionCard name="Browser" description="Browse" kind="plugin" connected connectedLabel="Enabled" statusBadge="icon-only" />); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Enabled");
  expect(renderer.root.findAll((node) => node.props.className?.includes?.("bg-green-9"))).toHaveLength(1);
});

test("disabled plugin has no enabled mark or status text", async () => {
  await act(async () => { renderer = TestRenderer.create(<ExtensionCard name="Voice" description="Speak" kind="plugin" connected={false} statusBadge="icon-only" />); });
  expect(renderer.root.findAll((node) => node.props.className?.includes?.("bg-green-9"))).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Enabled");
});

test("extension cards omit the redundant JuggleWork Extension type tag", async () => {
  await act(async () => { renderer = TestRenderer.create(<ExtensionCard name="Computer Use" description="Control apps" kind="extension" preview />); });
  const output = JSON.stringify(renderer.toJSON());
  expect(output).not.toContain("JuggleWork Extension");
  expect(output).toContain("Preview");
});
