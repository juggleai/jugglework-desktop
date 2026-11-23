// The ledger contains only today's deployment/account pairs, never credentials or input details.
const receiptKey = "jugglework.activity.activeDay";
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function receipts(storage: Storage, day: string): string[] {
  try {
    const saved = JSON.parse(storage.getItem(receiptKey) ?? "null");
    if (saved?.day === day && Array.isArray(saved.accounts)) return saved.accounts;
  } catch { /* Storage may be disabled. Keep the in-memory suppression. */ }
  return [];
}

export function createActiveDayRecorder(now = Date.now) {
  let day = "";
  const states = new Map<string, { attempts: number; next: number }>();
  return async (scope: string, post: () => Promise<void>, storage: Storage, isCurrent: () => boolean) => {
    const time = now();
    const today = utcDay(time);
    if (day !== today) { states.clear(); day = today; }
    const state = states.get(scope) ?? { attempts: 0, next: 0 };
    if (time < state.next || state.attempts >= 3) return;
    if (!isCurrent()) return;
    states.set(scope, state);
    state.next = Infinity; // in flight, or already acknowledged
    if (receipts(storage, today).includes(scope)) return;
    state.attempts++;
    try {
      await post();
    } catch {
      state.next = now() + 30_000 * 2 ** (state.attempts - 1);
      return; // No timer: retry only on another human interaction.
    }
    if (utcDay(now()) !== today) return;
    try {
      const accounts = new Set(receipts(storage, today));
      accounts.add(scope);
      storage.setItem(receiptKey, JSON.stringify({ day: today, accounts: [...accounts] }));
    } catch { /* In-memory acknowledgement is sufficient for this window. */ }
  };
}

export function listenForActiveDay(doc: Document, onInput: () => void) {
  const listener = (event: Event) => {
    if (event.isTrusted && doc.visibilityState === "visible" && doc.hasFocus()) onInput();
  };
  const options = { capture: true, passive: true };
  doc.addEventListener("pointerdown", listener, options);
  doc.addEventListener("keydown", listener, options);
  return () => {
    doc.removeEventListener("pointerdown", listener, true);
    doc.removeEventListener("keydown", listener, true);
  };
}
