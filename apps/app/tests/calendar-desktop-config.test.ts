import { describe, expect, test } from "bun:test";

import { normalizeDenDesktopConfig } from "../src/app/lib/den";
import { getDesktopConfigActions } from "../src/react-app/domains/cloud/desktop-config-provider";
import { resolveCalendarPageGate } from "../src/react-app/domains/calendar/calendar-page-gate";

const identity = {
  isSignedIn: true,
  baseUrl: "https://den.example/api",
  organizationId: "org-a",
  memberId: "member-a",
  configLoading: false,
};
const disabled = { calendarEnabled: false, calendarWriteEnabled: false };
const readOnly = { calendarEnabled: true, calendarWriteEnabled: false };
const writable = { calendarEnabled: true, calendarWriteEnabled: true };

describe("Calendar desktop config comparison", () => {
  test.each([
    { name: "enables reads", from: disabled, to: readOnly, items: ["calendarEnabled"], gate: { kind: "ready", writeEnabled: false } },
    { name: "enables writes", from: readOnly, to: writable, items: ["calendarWriteEnabled"], gate: { kind: "ready", writeEnabled: true } },
    { name: "revokes writes while retaining reads", from: writable, to: readOnly, items: ["calendarWriteEnabled"], gate: { kind: "ready", writeEnabled: false } },
    { name: "disables reads", from: readOnly, to: disabled, items: ["calendarEnabled"], gate: { kind: "disabled" } },
    { name: "disables a writable calendar", from: writable, to: disabled, items: ["calendarEnabled", "calendarWriteEnabled"], gate: { kind: "disabled" } },
  ])("$name on a gate-only refresh", ({ from, to, items, gate }) => {
    const currentConfig = normalizeDenDesktopConfig({ connectEnabled: true, ...from });
    // Keep every unrelated value (including object/array references) identical:
    // another config change must not accidentally make this refresh apply.
    const latestConfig = { ...currentConfig, ...to };
    expect(getDesktopConfigActions({ currentConfig, latestConfig: { ...currentConfig } })).toEqual([]);
    expect(getDesktopConfigActions({ currentConfig, latestConfig })).toEqual(items.map((item) => ({
      item,
      previousValue: from[item as keyof typeof from],
      nextValue: to[item as keyof typeof to],
    })));
    expect(resolveCalendarPageGate({ ...identity, ...latestConfig })).toMatchObject(gate);
  });

  test("missing or malformed gates revoke access rather than granting permissions", () => {
    const currentConfig = normalizeDenDesktopConfig(writable);
    for (const payload of [{}, { calendarEnabled: "true", calendarWriteEnabled: true }]) {
      const normalized = normalizeDenDesktopConfig(payload);
      const latestConfig = { ...currentConfig, calendarEnabled: normalized.calendarEnabled, calendarWriteEnabled: normalized.calendarWriteEnabled };
      expect(getDesktopConfigActions({ currentConfig, latestConfig }).map(({ item }) => item)).toEqual(["calendarEnabled", "calendarWriteEnabled"]);
      expect(resolveCalendarPageGate({ ...identity, ...latestConfig })).toEqual({ kind: "disabled" });
    }
  });

  test("enabled config never substitutes for sign-in or a complete membership scope", () => {
    const config = normalizeDenDesktopConfig(writable);
    expect(resolveCalendarPageGate({ ...identity, ...config, isSignedIn: false })).toEqual({ kind: "signed-out" });
    expect(resolveCalendarPageGate({ ...identity, ...config, organizationId: null })).toEqual({ kind: "no-organization" });
    expect(resolveCalendarPageGate({ ...identity, ...config, memberId: null })).toEqual({ kind: "membership-unavailable" });
    expect(resolveCalendarPageGate({ ...identity, ...config, baseUrl: "not a url" })).toEqual({ kind: "membership-unavailable" });
  });
});
