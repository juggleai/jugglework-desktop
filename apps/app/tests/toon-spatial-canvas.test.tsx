import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { createToonCanvasHistory } from "../src/react-app/domains/toon-factory/canvas/toon-canvas-domain";
import { ToonSpatialCanvas } from "../src/react-app/domains/toon-factory/canvas/toon-spatial-canvas";

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

describe("Toon retained canvas integration", () => {
  test("suspends the graph tree while retaining the draft and bounded history", async () => {
    const canvas = { schemaVersion: 2 as const, id: "main", nodes: [], edges: [], viewport: { x: 17, y: 23, zoom: 1.25 } };
    const history = createToonCanvasHistory(2);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ToonSpatialCanvas canvas={canvas} selection={["retained-selection"]} visible={false} history={history} conflict={false} assistantWidth={0} onChange={() => { throw new Error("A suspended canvas must not emit changes"); }} />);
    });
    expect(renderer.root.findByProps({ "data-testid": "toon-v2-canvas-suspended" })).toBeTruthy();
    expect(renderer.root.findAllByProps({ "data-testid": "toon-v2-spatial-canvas" })).toHaveLength(0);
    expect(canvas.viewport).toEqual({ x: 17, y: 23, zoom: 1.25 });
    expect(history).toMatchObject({ limit: 2, past: [], future: [] });
    await act(async () => { renderer.unmount(); });
  });
});
