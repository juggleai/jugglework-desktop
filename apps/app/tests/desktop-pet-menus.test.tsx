import { afterAll, afterEach, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { PetAction, PetActionResult, PetCapability, PetInteraction, PetSnapshot } from "../src/app/lib/desktop-pet-types";

const target = { key: "workspace:root", workspaceId: "workspace", sessionId: "root", project: "Project", title: "Original target" };
const skill: PetCapability = { id: "skill:guide", group: "skills", kind: "skill", name: "Guide" };
const connection: PetCapability = { id: "mcp:calendar", group: "mcp", kind: "mcp", name: "Calendar" };
const emptyInteraction = (): PetInteraction => ({ drafts: {}, targets: {}, dismissed: {}, target });
let snapshot: PetSnapshot;
let subscriber: ((value: PetSnapshot) => void) | undefined;
let renderedApp: React.ReactElement;
let renderer: TestRenderer.ReactTestRenderer | undefined;
const requests: { action: PetAction; resolve: (result: PetActionResult) => void; reject: (error: Error) => void }[] = [];
const remembered: PetInteraction[] = [];
const bridge = {
  getState: async () => snapshot,
  onState: (callback: typeof subscriber) => { subscriber = callback; return () => { subscriber = undefined; }; },
  remember: (interaction: PetInteraction) => {
    remembered.push(structuredClone(interaction));
    snapshot = { ...snapshot, interaction: structuredClone(interaction) };
    subscriber?.(snapshot);
  },
  action: (action: PetAction) => {
    if (action.type === "editing") return Promise.resolve({});
    return new Promise<PetActionResult>((resolve, reject) => { requests.push({ action, resolve, reject }); });
  },
  onFocus: () => () => {}, focusEditor: async () => {}, keyboard: () => {},
};
const savedGlobals = { window: globalThis.window, document: globalThis.document, Image: globalThis.Image, matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: Object.assign(new EventTarget(), { __JUGGLEWORK_PET__: bridge }),
   document: Object.assign(new EventTarget(), { documentElement: { dataset: {} }, getElementById: () => ({}), hidden: false, hasFocus: () => false }),
  Image: class {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
});
mock.module("react-dom/client", () => ({ createRoot: () => ({ render: (element: React.ReactElement) => { renderedApp = element; } }) }));
mock.module("../src/pet/use-pet-placement", () => ({ usePetPlacement: () => {} }));
await import("../src/pet/main");

async function mount(interaction = emptyInteraction()) {
  snapshot = { contextKey: "test", visible: true, ready: true, syncing: false, partial: false, tasks: [], locale: "en", theme: "light", editing: false, voicePhase: "idle", interaction };
  await act(async () => {
    renderer = TestRenderer.create(renderedApp, { createNodeMock: () => ({ querySelector: () => null, querySelectorAll: () => [], contains: () => false }) });
  });
}
const byClass = (name: string) => renderer!.root.find((node) => node.props.className === name);
const all = (name: string) => renderer!.root.findAll((node) => node.props.className === name);
async function click(name: string) { await act(async () => { byClass(name).props.onClick(); }); }
async function open() {
  await act(async () => { byClass("pet-tools").findAllByType("button")[0]!.props.onClick(); });
}
async function resolveRequest(index: number, result: PetActionResult) { await act(async () => { requests[index]!.resolve(result); }); }
async function closeMenu() {
  await act(async () => { byClass("pet-root").props.onKeyDown({ key: "Escape", nativeEvent: {}, }); });
}
afterEach(async () => {
  await act(async () => { renderer?.unmount(); renderer = undefined; });
  requests.length = 0; remembered.length = 0;
});

test("selected capability-only drafts survive remount and retain the original target", async () => {
  await mount();
  await open();
  await resolveRequest(0, { target });
  await click("pet-input-plus");
  await resolveRequest(1, { capabilities: [skill] });
  await resolveRequest(2, { capabilities: [connection] });
  await act(async () => { renderer!.root.findByProps({ className: "pet-capability-name", children: skill.name }).parent!.props.onClick(); });
  expect(remembered.at(-1)?.selectedCapabilities?.__quick__).toEqual([skill]);
  const saved = structuredClone(snapshot.interaction!);
  await act(async () => { renderer!.unmount(); });
  await mount(saved);
  await open();
  expect(requests.filter(({ action }) => action.type === "latest")).toHaveLength(1);
  expect(all("pet-selected-capability")).toHaveLength(1);
  expect(byClass("pet-send").props.disabled).toBe(false);
  await click("pet-send");
  expect(requests.at(-1)?.action).toMatchObject({ type: "send", target, text: "", capabilities: [skill] });
});

test("session menu close and reopen shares its pending request and consumes its result", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-target");
  await closeMenu();
  await click("pet-target");
  expect(requests.map(({ action }) => action.type)).toEqual(["sessions"]);
  await resolveRequest(0, { targets: [target], partial: true });
  expect(all("pet-session-option")).toHaveLength(1);
  expect(byClass("pet-input-options").props["aria-busy"]).toBe(false);
});

test("capability close/reopen keeps both in-flight scopes and displays each result", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await closeMenu();
  await click("pet-input-plus");
  expect(requests).toHaveLength(2);
  await resolveRequest(0, { capabilities: [skill] });
  expect(all("pet-capability-option")).toHaveLength(1);
  expect(byClass("pet-input-options").props["aria-busy"]).toBe(true);
  await resolveRequest(1, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(2);
  expect(byClass("pet-input-options").props["aria-busy"]).toBe(false);
});

test("reopening shows cached capabilities immediately and revalidates both scopes", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await resolveRequest(0, { capabilities: [skill] });
  await resolveRequest(1, { capabilities: [connection] });
  await closeMenu();
  await click("pet-input-plus");
  expect(requests).toHaveLength(4);
  expect(all("pet-capability-option")).toHaveLength(2);
  expect(byClass("pet-input-options").props["aria-busy"]).toBe(true);
  await resolveRequest(2, { capabilities: [] });
  expect(all("pet-capability-option")).toHaveLength(1);
  await resolveRequest(3, { capabilities: [{ ...connection, disabled: true }] });
  expect(byClass("pet-capability-option").props.disabled).toBe(true);
});

test("switching menus while loading still lets reopened menus consume their results", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await click("pet-target");
  await click("pet-input-plus");
  expect(requests).toHaveLength(3);
  await resolveRequest(0, { capabilities: [skill] });
  await resolveRequest(1, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(2);
  await click("pet-target");
  expect(requests).toHaveLength(3);
  await resolveRequest(2, { targets: [target] });
  expect(all("pet-session-option")).toHaveLength(1);
});

test("a completed scope discarded while closed is reloaded while its pending sibling is reused", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await closeMenu();
  await resolveRequest(0, { capabilities: [skill] });
  await click("pet-input-plus");
  expect(requests).toHaveLength(3);
  expect(requests[2]!.action).toMatchObject({ type: "capabilities", scope: "basic" });
  await resolveRequest(1, { capabilities: [connection] });
  await resolveRequest(2, { capabilities: [skill] });
  expect(all("pet-capability-option")).toHaveLength(2);
});

test("rejected menu requests can be retried on reopen", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await act(async () => { requests[0]!.reject(new Error("unavailable")); requests[1]!.reject(new Error("unavailable")); });
  await closeMenu();
  await click("pet-input-plus");
  expect(requests).toHaveLength(4);
  await resolveRequest(2, { capabilities: [skill] });
  await resolveRequest(3, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(2);
});

test("a new target does not reuse or display the previous target's pending capabilities", async () => {
  await mount({ ...emptyInteraction(), drafts: { __quick__: "draft" } });
  await open();
  await click("pet-input-plus");
  await click("pet-target");
  const other = { ...target, key: "other:root", workspaceId: "other", title: "Other target" };
  await resolveRequest(2, { targets: [other] });
  await click("pet-session-option");
  await click("pet-input-plus");
  expect(requests).toHaveLength(5);
  await resolveRequest(0, { capabilities: [skill] });
  await resolveRequest(1, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(0);
  expect(byClass("pet-input-options").props["aria-busy"]).toBe(true);
  await resolveRequest(3, { capabilities: [{ ...skill, id: "skill:other" }] });
  await resolveRequest(4, { capabilities: [] });
  expect(all("pet-capability-option")).toHaveLength(1);
});

test("account changes invalidate old requests and capability selections", async () => {
  await mount({ ...emptyInteraction(), selectedCapabilities: { __quick__: [skill] } });
  await open();
  await click("pet-input-plus");
  await act(async () => {
    snapshot = { ...snapshot, contextKey: "other-account", interaction: { ...emptyInteraction(), drafts: { __quick__: "new account draft" } } };
    subscriber!(snapshot);
  });
  await open();
  expect(all("pet-selected-capability")).toHaveLength(0);
  await click("pet-input-plus");
  expect(requests).toHaveLength(4);
  await resolveRequest(0, { capabilities: [skill] });
  await resolveRequest(1, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(0);
  await resolveRequest(2, { capabilities: [] });
  await resolveRequest(3, { capabilities: [connection] });
  expect(all("pet-capability-option")).toHaveLength(1);
});

test("deleting a selected capability during a send is remembered and retained on receipt", async () => {
  await mount({ ...emptyInteraction(), selectedCapabilities: { __quick__: [skill, connection] } });
  await open();
  await click("pet-send");
  await act(async () => { all("pet-selected-capability")[0]!.props.onKeyDown({ key: "Delete", nativeEvent: {}, preventDefault() {} }); });
  expect(remembered.at(-1)?.selectedCapabilities?.__quick__).toEqual([connection]);
  await resolveRequest(0, { delivery: "sent" });
  expect(all("pet-selected-capability")).toHaveLength(1);
  expect(all("pet-composer")).toHaveLength(1);
});

afterAll(() => { Object.assign(globalThis, savedGlobals); });
