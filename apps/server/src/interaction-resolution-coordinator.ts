import { randomUUID as cryptoRandomUUID } from "node:crypto";

export type InteractionOrigin = "local-renderer" | "remote-control";
export type InteractionKind = "permission" | "question";
export type InteractionResolutionStatus = "pending" | "reserved" | "resolved" | "expired";

interface PendingInteraction {
  status: "pending";
  firstSeenAt: number;
  expiresAt: number;
  sequence: number;
}

interface ReservedInteraction {
  status: "reserved";
  reservationId: string;
  origin: InteractionOrigin;
  commandCorrelationId: string | null;
  firstSeenAt: number;
  expiresAt: number;
  reservedAt: number;
  sequence: number;
}

interface ResolvedInteraction {
  status: "resolved";
  origin: InteractionOrigin;
  commandCorrelationId: string | null;
  resolvedAt: number;
  expiresAt: number;
  purgeAt: number;
  sequence: number;
}

interface ExpiredInteraction {
  status: "expired";
  expiredAt: number;
  purgeAt: number;
  sequence: number;
}

type StoredInteraction = PendingInteraction | ReservedInteraction | ResolvedInteraction | ExpiredInteraction;

export interface InteractionScope {
  workspaceId: string;
  sessionId: string;
  interactionId: string;
  kind: InteractionKind;
}

export interface InteractionReservation extends InteractionScope {
  reservationId: string;
  origin: InteractionOrigin;
  commandCorrelationId: string | null;
}

export interface InteractionTombstone extends InteractionScope {
  status: "resolved" | "expired";
  origin?: InteractionOrigin;
  commandCorrelationId?: string | null;
  resolvedAt?: number;
  expiredAt?: number;
  expiresAt?: number;
  purgeAt: number;
}

export class InteractionResolutionError extends Error {
  constructor(public readonly code: "already_resolved" | "interaction_expired" | "interaction_not_found") {
    super(code);
    this.name = "InteractionResolutionError";
  }
}

function interactionKey(scope: InteractionScope): string {
  return `${scope.workspaceId}\0${scope.sessionId}\0${scope.kind}\0${scope.interactionId}`;
}

function scopeFromKey(key: string): InteractionScope {
  const [workspaceId = "", sessionId = "", kind = "permission", interactionId = ""] = key.split("\0");
  return { workspaceId, sessionId, kind: kind as InteractionKind, interactionId };
}

export function createInteractionResolutionCoordinator(options: {
  now?: () => number;
  randomUUID?: () => string;
  pendingTtlMs?: number;
  tombstoneTtlMs?: number;
  expiredRetentionMs?: number;
  maxPending?: number;
  maxTerminal?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;
  const pendingTtlMs = options.pendingTtlMs ?? 10 * 60_000;
  const tombstoneTtlMs = options.tombstoneTtlMs ?? 10 * 60_000;
  const expiredRetentionMs = options.expiredRetentionMs ?? 10 * 60_000;
  const maxPending = options.maxPending ?? 1_000;
  const maxTerminal = options.maxTerminal ?? 1_000;
  const interactions = new Map<string, StoredInteraction>();
  let sequence = 0;

  function maintain(timestamp = now()): void {
    for (const [key, interaction] of interactions) {
      if (interaction.status === "pending" && timestamp >= interaction.expiresAt) {
        interactions.set(key, {
          status: "expired",
          expiredAt: interaction.expiresAt,
          purgeAt: interaction.expiresAt + expiredRetentionMs,
          sequence: interaction.sequence,
        });
      } else if (interaction.status === "resolved" && timestamp >= interaction.expiresAt) {
        interactions.set(key, {
          status: "expired",
          expiredAt: interaction.expiresAt,
          purgeAt: interaction.expiresAt + expiredRetentionMs,
          sequence: interaction.sequence,
        });
      }
    }

    for (const [key, interaction] of interactions) {
      if (interaction.status === "expired" && timestamp >= interaction.purgeAt) interactions.delete(key);
    }

    const activeCount = [...interactions.values()].filter(
      (interaction) => interaction.status === "pending" || interaction.status === "reserved",
    ).length;
    const pending = [...interactions.entries()]
      .filter((entry): entry is [string, PendingInteraction] => entry[1].status === "pending")
      .sort((left, right) => left[1].firstSeenAt - right[1].firstSeenAt || left[1].sequence - right[1].sequence);
    for (let index = 0; index < activeCount - maxPending; index++) interactions.delete(pending[index]![0]);

    const terminal = [...interactions.entries()]
      .filter((entry): entry is [string, ResolvedInteraction | ExpiredInteraction] =>
        entry[1].status === "resolved" || entry[1].status === "expired")
      .sort((left, right) => {
        const leftAt = left[1].status === "resolved" ? left[1].resolvedAt : left[1].expiredAt;
        const rightAt = right[1].status === "resolved" ? right[1].resolvedAt : right[1].expiredAt;
        return leftAt - rightAt || left[1].sequence - right[1].sequence;
      });
    for (let index = 0; index < terminal.length - maxTerminal; index++) interactions.delete(terminal[index]![0]);
  }

  function status(scope: InteractionScope): InteractionResolutionStatus | null {
    maintain();
    return interactions.get(interactionKey(scope))?.status ?? null;
  }

  function observePending(scope: InteractionScope): void {
    maintain();
    const key = interactionKey(scope);
    const existing = interactions.get(key);
    if (existing?.status === "reserved" || existing?.status === "resolved") {
      throw new InteractionResolutionError("already_resolved");
    }
    if (existing?.status === "expired") throw new InteractionResolutionError("interaction_expired");
    if (existing) return;
    const timestamp = now();
    interactions.set(key, {
      status: "pending",
      firstSeenAt: timestamp,
      expiresAt: timestamp + pendingTtlMs,
      sequence: ++sequence,
    });
    maintain(timestamp);
  }

  function reserve(input: InteractionScope & {
    origin: InteractionOrigin;
    commandCorrelationId: string | null;
  }): InteractionReservation {
    maintain();
    const key = interactionKey(input);
    const existing = interactions.get(key);
    if (existing?.status === "reserved" || existing?.status === "resolved") {
      throw new InteractionResolutionError("already_resolved");
    }
    if (existing?.status === "expired") throw new InteractionResolutionError("interaction_expired");
    if (!existing) throw new InteractionResolutionError("interaction_not_found");

    const reservationId = randomUUID();
    interactions.set(key, {
      ...existing,
      status: "reserved",
      reservationId,
      origin: input.origin,
      commandCorrelationId: input.commandCorrelationId,
      reservedAt: now(),
    });
    return { ...input, reservationId };
  }

  function accept(reservation: InteractionReservation): boolean {
    const key = interactionKey(reservation);
    const existing = interactions.get(key);
    if (existing?.status !== "reserved" || existing.reservationId !== reservation.reservationId) return false;
    const timestamp = now();
    interactions.set(key, {
      status: "resolved",
      origin: existing.origin,
      commandCorrelationId: existing.commandCorrelationId,
      resolvedAt: timestamp,
      expiresAt: timestamp + tombstoneTtlMs,
      purgeAt: timestamp + tombstoneTtlMs + expiredRetentionMs,
      sequence: existing.sequence,
    });
    maintain(timestamp);
    return true;
  }

  function rollback(reservation: InteractionReservation): boolean {
    const key = interactionKey(reservation);
    const existing = interactions.get(key);
    if (existing?.status !== "reserved" || existing.reservationId !== reservation.reservationId) return false;
    interactions.set(key, {
      status: "pending",
      firstSeenAt: existing.firstSeenAt,
      expiresAt: existing.expiresAt,
      sequence: existing.sequence,
    });
    maintain();
    return true;
  }

  function listTombstones(): InteractionTombstone[] {
    maintain();
    const tombstones: InteractionTombstone[] = [];
    for (const [key, interaction] of interactions) {
      if (interaction.status === "resolved") {
        tombstones.push({
          ...scopeFromKey(key),
          status: interaction.status,
          origin: interaction.origin,
          commandCorrelationId: interaction.commandCorrelationId,
          resolvedAt: interaction.resolvedAt,
          expiresAt: interaction.expiresAt,
          purgeAt: interaction.purgeAt,
        });
      }
      if (interaction.status === "expired") {
        tombstones.push({
          ...scopeFromKey(key),
          status: interaction.status,
          expiredAt: interaction.expiredAt,
          purgeAt: interaction.purgeAt,
        });
      }
    }
    return tombstones;
  }

  return Object.freeze({ status, observePending, reserve, accept, rollback, listTombstones });
}

export type InteractionResolutionCoordinator = ReturnType<typeof createInteractionResolutionCoordinator>;
