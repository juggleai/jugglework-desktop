import { describe, expect, test } from "bun:test";

import {
  createInteractionResolutionCoordinator,
  InteractionResolutionError,
  type InteractionScope,
} from "./interaction-resolution-coordinator.js";

const scope = (interactionId: string): InteractionScope => ({
  workspaceId: "ws",
  sessionId: "ses",
  interactionId,
  kind: "permission",
});

describe("interaction resolution coordinator", () => {
  test("reserves synchronously, first writer wins, and exact rollback permits retry", () => {
    let id = 0;
    const coordinator = createInteractionResolutionCoordinator({
      now: () => 1_000,
      randomUUID: () => `reservation-${++id}`,
    });
    coordinator.observePending(scope("interaction"));
    const first = coordinator.reserve({
      ...scope("interaction"),
      origin: "local-renderer",
      commandCorrelationId: "local-command",
    });
    expect(() => coordinator.reserve({
      ...scope("interaction"),
      origin: "remote-control",
      commandCorrelationId: "remote-command",
    })).toThrow(new InteractionResolutionError("already_resolved"));
    expect(coordinator.rollback({ ...first, reservationId: "stale" })).toBe(false);
    expect(coordinator.rollback(first)).toBe(true);
    const retry = coordinator.reserve({
      ...scope("interaction"),
      origin: "remote-control",
      commandCorrelationId: null,
    });
    expect(coordinator.accept(retry)).toBe(true);
    expect(coordinator.accept(first)).toBe(false);
  });

  test("expires pending and resolved entries, then purges them deterministically", () => {
    let now = 100;
    const coordinator = createInteractionResolutionCoordinator({
      now: () => now,
      randomUUID: () => "reservation",
      pendingTtlMs: 10,
      tombstoneTtlMs: 20,
      expiredRetentionMs: 30,
    });
    coordinator.observePending(scope("pending"));
    now = 110;
    expect(coordinator.status(scope("pending"))).toBe("expired");
    expect(() => coordinator.reserve({
      ...scope("pending"),
      origin: "local-renderer",
      commandCorrelationId: null,
    })).toThrow(new InteractionResolutionError("interaction_expired"));
    now = 140;
    expect(coordinator.status(scope("pending"))).toBeNull();

    now = 200;
    coordinator.observePending(scope("resolved"));
    const reservation = coordinator.reserve({
      ...scope("resolved"),
      origin: "remote-control",
      commandCorrelationId: "command",
    });
    coordinator.accept(reservation);
    now = 220;
    expect(coordinator.status(scope("resolved"))).toBe("expired");
    now = 250;
    expect(coordinator.status(scope("resolved"))).toBeNull();
  });

  test("retains bounded content-minimized terminal tombstones", () => {
    let now = 1_000;
    let id = 0;
    const coordinator = createInteractionResolutionCoordinator({
      now: () => ++now,
      randomUUID: () => `reservation-${++id}`,
      maxTerminal: 2,
    });
    for (const interactionId of ["one", "two", "three"]) {
      const current = scope(interactionId);
      coordinator.observePending(current);
      coordinator.accept(coordinator.reserve({
        ...current,
        origin: "local-renderer",
        commandCorrelationId: `command-${interactionId}`,
      }));
    }
    const tombstones = coordinator.listTombstones();
    expect(tombstones).toHaveLength(2);
    expect(tombstones.map((entry) => entry.interactionId)).toEqual(["two", "three"]);
    const serialized = JSON.stringify(tombstones);
    expect(serialized).not.toContain("answer");
    expect(serialized).not.toContain("resource");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("tool");
  });

  test("bounds pending and reserved state without evicting an in-flight writer", () => {
    let id = 0;
    const coordinator = createInteractionResolutionCoordinator({
      randomUUID: () => `reservation-${++id}`,
      maxPending: 1,
    });
    coordinator.observePending(scope("reserved"));
    coordinator.reserve({
      ...scope("reserved"),
      origin: "local-renderer",
      commandCorrelationId: null,
    });
    coordinator.observePending(scope("overflow"));
    expect(coordinator.status(scope("reserved"))).toBe("reserved");
    expect(coordinator.status(scope("overflow"))).toBeNull();
  });

  test("unknown interactions are not found and scopes do not collide", () => {
    const coordinator = createInteractionResolutionCoordinator();
    expect(() => coordinator.reserve({
      ...scope("unknown"),
      origin: "local-renderer",
      commandCorrelationId: null,
    })).toThrow(new InteractionResolutionError("interaction_not_found"));
    coordinator.observePending(scope("same-id"));
    expect(coordinator.status({ ...scope("same-id"), sessionId: "other" })).toBeNull();
  });
});
