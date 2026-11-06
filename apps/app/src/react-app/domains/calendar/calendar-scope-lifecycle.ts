import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";

export type CalendarScopeGeneration = Readonly<{
  scope: CalendarScope;
  identity: string;
  generation: number;
  signal: AbortSignal;
}>;

export class CalendarScopeStaleError extends Error {
  constructor() {
    super("Calendar scope generation is no longer current.");
    this.name = "CalendarScopeStaleError";
  }
}

export function throwIfCalendarScopeStale(generation: CalendarScopeGeneration | null | undefined, signal?: AbortSignal): void {
  if (signal?.aborted || generation?.signal.aborted) throw new CalendarScopeStaleError();
}

export function calendarRequestSignal(signal: AbortSignal, generation?: CalendarScopeGeneration | null): AbortSignal {
  if (!generation) return signal;
  return AbortSignal.any([signal, generation.signal]);
}

export function createCalendarScopeLifecycle() {
  let sequence = 0;
  let current: CalendarScopeGeneration | null = null;
  let controller: AbortController | null = null;

  const transition = (scope: CalendarScope | null) => {
    const nextIdentity = calendarScopeIdentity(scope);
    if (current?.identity === nextIdentity || (!current && nextIdentity === null)) {
      return { previous: current, current, changed: false };
    }
    const previous = current;
    current = null;
    controller?.abort(new CalendarScopeStaleError());
    controller = null;
    sequence += 1;
    if (scope && nextIdentity) {
      controller = new AbortController();
      current = Object.freeze({ scope: Object.freeze({ ...scope }), identity: nextIdentity, generation: sequence, signal: controller.signal });
    }
    return { previous, current, changed: true };
  };

  return {
    current: () => current,
    transition,
    isCurrent(generation: CalendarScopeGeneration): boolean {
      return current === generation && !generation.signal.aborted;
    },
    throwIfStale(generation: CalendarScopeGeneration): void {
      if (current !== generation || generation.signal.aborted) throw new CalendarScopeStaleError();
    },
    dispose(): void {
      current = null;
      controller?.abort(new CalendarScopeStaleError());
      controller = null;
      sequence += 1;
    },
  };
}
