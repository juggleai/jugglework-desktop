import { expect, test } from "bun:test";
import { placePetPanel, placePetInputOptions } from "../src/pet/placement";
import type { PetViewport } from "../src/app/lib/desktop-pet-types";

const viewport = (x: number, y: number, screenX = 0): PetViewport => ({ width: 400, height: 900, screenX, character: { x, y }, workArea: { x: 0, y: 0, width: 1440, height: 900 } });

test("top and bottom edges flip task panels toward the available side", () => {
  expect(placePetPanel(viewport(148, 28, 500), 120, 260, 195, "above").side).toBe("below");
  expect(placePetPanel(viewport(148, 680, 500), 120, 260, 847, "below").side).toBe("above");
});
test("edge task panels align with the left or right edge of the bubble", () => {
  const left = placePetPanel(viewport(40, 400), 120, 200, 567, "above");
  expect(left.align).toBe("left"); expect(left.x).toBe(32);
  const right = placePetPanel(viewport(256, 400, 1040), 120, 200, 567, "above");
  expect(right.align).toBe("right"); expect(right.x + right.width).toBe(368);
  const center = placePetPanel(viewport(148, 400, 500), 120, 200, 567, "above");
  expect(center.align).toBe("center"); expect(center.x + center.width / 2).toBe(200);
});
test("dragging near a constrained threshold does not flip repeatedly", () => {
  expect(placePetPanel(viewport(148, 400, 500), 120, 700, 567, "above").side).toBe("above");
  expect(placePetPanel(viewport(148, 350, 500), 120, 700, 517, "above").side).toBe("below");
  expect(placePetPanel(viewport(148, 365, 500), 120, 700, 532, "below").side).toBe("below");
  expect(placePetPanel(viewport(148, 372, 500), 120, 329, 539, "above").side).toBe("above");
  expect(placePetPanel(viewport(148, 373, 500), 120, 329, 540, "below").side).toBe("below");
});
test("narrow and negative-origin displays keep alignment within the canvas", () => {
  const area = { x: -1000, y: -100, width: 360, height: 640 };
  const result = placePetPanel({ width: 360, height: 640, screenX: -1000, character: { x: 40, y: 28 }, workArea: area }, 80, 500, 195, "above");
  expect(result.x).toBe(52); expect(result.x + result.width).toBeLessThanOrEqual(328);
  expect(result.side).toBe("below"); expect(result.maxHeight).toBe(413);
});

test("plus menu stays eight pixels from the composer and chooses the side with space", () => {
  const below = placePetInputOptions(900, { top: 190, bottom: 230 }, 320, "below");
  expect(below).toMatchObject({ side: "below", top: 238 });
  const above = placePetInputOptions(900, { top: 780, bottom: 820 }, 320, "below");
  expect(above.side).toBe("above"); expect(780 - (above.top + 320)).toBe(8);
});

test("constrained plus menus scroll on the roomier side without moving the input anchor", () => {
  const menu = placePetInputOptions(420, { top: 240, bottom: 280 }, 320, "below");
  expect(menu).toEqual({ side: "above", top: 16, maxHeight: 216 });
  expect(placePetInputOptions(420, { top: 195, bottom: 235 }, 320, "above").side).toBe("above");
});
