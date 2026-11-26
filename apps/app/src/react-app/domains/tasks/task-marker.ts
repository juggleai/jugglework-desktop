/** Keep the diamond within the circle's footprint and its status glyph upright. */
export function taskMarkerShape(isMilestone?: boolean) {
  return isMilestone ? "scale-[0.8] rotate-45 rounded-[1px] [&>svg]:-rotate-45" : "rounded-full";
}
