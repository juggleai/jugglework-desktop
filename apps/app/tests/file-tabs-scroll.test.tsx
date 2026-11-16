/** @jsxImportSource react */
import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FileTabs } from "../src/react-app/domains/session/files/file-tabs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("new, previous, changes and cloud tabs scroll horizontally into view without unrelated resets", async () => {
  const viewport = { clientWidth: 200, scrollLeft: 0 };
  const positions: Record<string, { offsetLeft: number; offsetWidth: number }> = {
    changes: { offsetLeft: 0, offsetWidth: 80 },
    "file:first.md": { offsetLeft: 84, offsetWidth: 100 },
    "file:second.md": { offsetLeft: 188, offsetWidth: 100 },
    "file:third.md": { offsetLeft: 292, offsetWidth: 100 },
    "cloud:cloud-doc": { offsetLeft: 396, offsetWidth: 100 },
  };
  const callbacks = new Set<() => void>();
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(private callback: () => void) { callbacks.add(callback); }
    observe() {}
    disconnect() { callbacks.delete(this.callback); }
  } });
  const files = ["first.md", "second.md", "third.md"].map(path => ({ path, name: path }));
  const render = (activePath: string | null, count: number, changesActive = false, cloudActive = false) => <FileTabs
    tabs={files.slice(0, count)} activePath={activePath} dirtyPaths={new Set()}
    changesTab={{ label: "Changes", count: 3, active: changesActive, onSelect() {} }}
    cloudTabs={cloudActive ? [{ key: "cloud-doc", title: "Cloud document", active: true, onSelect() {}, onClose() {} }] : []}
    onSelect={() => {}} onClose={() => {}}
  />;
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(render("first.md", 2), { createNodeMock: element => {
      if (element.props["data-testid"] === "file-tabs") return viewport;
      return positions[element.props["data-file-tab-key"]] ?? null;
    } }); });
    expect(viewport.scrollLeft).toBe(0);
    await act(async () => view!.update(render("third.md", 3)));
    expect(viewport.scrollLeft).toBe(192);
    await act(async () => view!.update(render("first.md", 3)));
    expect(viewport.scrollLeft).toBe(84);
    await act(async () => view!.update(render(null, 3, true)));
    expect(viewport.scrollLeft).toBe(0);
    await act(async () => view!.update(render(null, 3, false, true)));
    expect(viewport.scrollLeft).toBe(296);
    viewport.clientWidth = 120;
    await act(async () => callbacks.forEach(callback => callback()));
    expect(viewport.scrollLeft).toBe(376);
    viewport.scrollLeft = 0;
    await act(async () => view!.update(render(null, 3, false, true)));
    expect(viewport.scrollLeft).toBe(0);
    viewport.clientWidth = 0;
    await act(async () => callbacks.forEach(callback => callback()));
    expect(viewport.scrollLeft).toBe(0);
    viewport.clientWidth = 200;
    await act(async () => callbacks.forEach(callback => callback()));
    expect(viewport.scrollLeft).toBe(296);
  } finally {
    await act(async () => view?.unmount());
    if (originalObserver) Object.defineProperty(globalThis, "ResizeObserver", originalObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
