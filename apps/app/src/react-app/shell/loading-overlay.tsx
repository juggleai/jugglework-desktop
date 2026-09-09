/** @jsxImportSource react */
import { useBootState, useBootOverlayVisible } from "./boot-state";
import { OwDotTicker } from "./dot-ticker";

/**
 * Quiet, opaque boot overlay. Solid surface fill so nothing bleeds through.
 * A minimal typographic beat plus a small dot ticker. Fades once both the
 * boot hook and the first route load are ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, message, error } = useBootState();

  if (!visible) return null;

  const fading = phase === "ready";

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-[1000] flex items-center justify-center bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[320px] flex-col items-center gap-4 px-6 text-center">
        <OwDotTicker size="md" />
        <div className="text-[12px] leading-5 text-dls-secondary">
          {message || "Preparing workspace"}
        </div>
        {error ? (
          <div className="flex flex-col gap-2 text-[12px] leading-5 text-red-11">
            <div>{error}</div>
            <div className="text-dls-secondary">
              Retry after checking your connection. JuggleWork will not switch to an unapproved update source.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
