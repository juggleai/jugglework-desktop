import { describe, expect, test } from "bun:test";
import { createToonPerformanceFixture, measureToonFixture, TOON_PERFORMANCE_THRESHOLDS } from "../src/react-app/domains/toon-factory/toon-workspace-performance";

describe("Toon workspace measured scale gates", () => {
  for (const size of ["small", "large"] as const) {
    test(`${size} fixture stays inside recorded direct-render and direct-search thresholds`, () => {
      const measurement = measureToonFixture(createToonPerformanceFixture(size));
      expect(measurement.firstOpenMs).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.firstOpenMs);
      expect(measurement.retainedHiddenBytes).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.retainedHiddenBytes);
      expect(measurement.canvasFrameMs).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.canvasFrameMs);
      expect(measurement.largeDocumentMs).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.largeDocumentMs);
      expect(measurement.directSearchMs).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.directSearchMs);
      expect(measurement.assistantEventsMs).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.assistantEventsMs);
      expect(measurement.assistantEventBytes).toBeLessThan(TOON_PERFORMANCE_THRESHOLDS.assistantEventBytes);
      console.info(`toon-performance:${size}`, JSON.stringify(measurement));
    });
  }

  test("keeps P2 virtualization and indexing measurement-gated", () => {
    const measurement = measureToonFixture(createToonPerformanceFixture("large"));
    const exceeded = Object.entries(measurement).filter(([name, value]) => value >= TOON_PERFORMANCE_THRESHOLDS[name as keyof typeof TOON_PERFORMANCE_THRESHOLDS]);
    expect(exceeded).toEqual([]);
  });
});
