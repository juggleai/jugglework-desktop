import type { SVGProps } from "react";
const paths = {
  expand: "M14 3h7v7 M21 3l-7 7 M10 21H3v-7 M3 21l7-7",
  hangup: "M4 15v-3q8-8 16 0v3l-4-1v-3 M4 15l4-1v-3",
  video:
    "M6 5h7a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3 M16 10l4-2.7a.65.65 0 0 1 1 .5v8.4a.65.65 0 0 1-1 .5L16 14",
  calendar:
    "M7 5h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3 M8 2v6 M16 2v6 M4 11h16",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M6 18L18 6",
  mic: "M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8",
  screen:
    "M6 3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3 M8 21h8 M12 17v4 M8 10l4-4 4 4 M12 6v8",
  chat: "M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4.3 3a.5.5 0 0 1-.7-.5V17a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3",
  users:
    "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 3a4 4 0 0 1 0 8 M22 21v-3a4 4 0 0 0-3-3.8",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 3q2-2 4 0l1 2 3 .5q2 0 2.5 2.5l-1 3 1 3q.5 2-2 3l-3 .5-1 2q-2 2-4 0l-1-2-3-.5q-2 0-2.5-2.5l1-3-1-3q-.5-2 2-3L9 5z",
};
export function MeetingIcon({
  name = "video",
  off,
  ...props
}: SVGProps<SVGSVGElement> & { name?: keyof typeof paths; off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
      {off ? <path d="m3 3 18 18" /> : null}
    </svg>
  );
}
