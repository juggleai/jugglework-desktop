import { afterEach, describe, expect, test } from "bun:test";

import { hasNativeBrowserOccluder, rectanglesOverlap } from "../src/react-app/domains/session/panel/utils";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

class Overlay {
  offsetParent: object | null = {};

  constructor(private readonly bounds: { x: number; y: number; width: number; height: number }) {}

  getClientRects() {
    return this.offsetParent === null ? [] : [this.bounds];
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

function installOverlays(input: { modals?: Overlay[]; floating?: Overlay[] }) {
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Overlay });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        return selector.startsWith('[role="alertdialog"]') ? input.modals ?? [] : input.floating ?? [];
      },
    },
  });
}

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalHTMLElement) Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

describe("native browser occlusion", () => {
  const browser = { x: 700, y: 100, width: 500, height: 700 };

  test("keeps the native page visible for a menu confined to the conversation side", () => {
    installOverlays({ floating: [new Overlay({ x: 300, y: 500, width: 320, height: 400 })] });
    expect(hasNativeBrowserOccluder(browser)).toBe(false);
  });

  test("treats a non-modal popover dialog as a local floating surface", () => {
    installOverlays({ floating: [new Overlay({ x: 300, y: 500, width: 320, height: 400 })] });
    expect(hasNativeBrowserOccluder(browser)).toBe(false);
  });

  test("hides for a floating menu that intersects the native page", () => {
    installOverlays({ floating: [new Overlay({ x: 650, y: 500, width: 200, height: 300 })] });
    expect(hasNativeBrowserOccluder(browser)).toBe(true);
  });

  test("always hides for a modal dialog and preserves legacy calls without target bounds", () => {
    installOverlays({ modals: [new Overlay({ x: 100, y: 100, width: 200, height: 200 })] });
    expect(hasNativeBrowserOccluder(browser)).toBe(true);

    installOverlays({ floating: [new Overlay({ x: 100, y: 100, width: 200, height: 200 })] });
    expect(hasNativeBrowserOccluder()).toBe(true);
  });

  test("treats touching edges as non-overlapping", () => {
    expect(rectanglesOverlap(browser, { x: 500, y: 200, width: 200, height: 100 })).toBe(false);
    expect(rectanglesOverlap(browser, { x: 699, y: 200, width: 2, height: 100 })).toBe(true);
  });
});
