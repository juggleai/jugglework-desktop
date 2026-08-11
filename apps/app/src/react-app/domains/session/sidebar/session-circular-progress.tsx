/** @jsxImportSource react */

/** Shared session/workspace activity indicator. */
export function SessionCircularProgress() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 animate-spin text-dls-accent motion-reduce:animate-none"
      style={{ animationDuration: "850ms" }}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        opacity="0.18"
      />
      <circle
        cx="8"
        cy="8"
        r="5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        pathLength="100"
        strokeDasharray="52 48"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
