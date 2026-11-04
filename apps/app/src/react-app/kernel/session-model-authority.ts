import type { ModelRef } from "../../app/types";
import type { JuggleWorkSessionModelPreference } from "../../app/lib/jugglework-server";

// Only legacy/unresolved preferences may be seeded from Desktop. Persisted
// explicit choices always win, including choices made on a phone while offline.
export function sessionModelSeed(
  preference: JuggleWorkSessionModelPreference,
  legacy: ModelRef | null | undefined,
  desktopDefault: ModelRef | null | undefined,
): ModelRef | null {
  if (preference.mode !== "auto") return null;
  return (preference.revision === 0 ? legacy : null) ?? desktopDefault ?? null;
}

export function sessionModelReadIsCurrent(currentGeneration: number | undefined, readGeneration: number): boolean {
  return (currentGeneration ?? 0) === readGeneration;
}
