import type { ITheme } from "@xterm/xterm";

type Rgba = readonly [number, number, number, number];
type ReadColor = (token: string) => Rgba | null;

// xterm does not accept CSS variables or modern color functions. Flatten alpha
// onto an opaque surface too: its default renderer has allowTransparency=false.
export function opaqueTerminalColor(color: Rgba | null, fallback: string, surface = fallback): string {
  if (!color || color[3] === 0) return fallback;
  const alpha = color[3] / 255;
  return `#${color.slice(0, 3).map((channel, i) => {
    const base = Number.parseInt(surface.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(channel * alpha + base * (1 - alpha)).toString(16).padStart(2, "0");
  }).join("")}`;
}

export function resolveTerminalTheme(read: ReadColor, dark: boolean): ITheme {
  const background = opaqueTerminalColor(read("--background"), dark ? "#111113" : "#ffffff");
  const foreground = opaqueTerminalColor(read("--foreground"), dark ? "#edeef0" : "#1c2024", background);
  const selectionBackground = opaqueTerminalColor(read("--dls-accent"), dark ? "#3e63dd" : "#0090ff", background);
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground,
    selectionForeground: opaqueTerminalColor(read("--dls-accent-fg"), "#ffffff", selectionBackground),
    // xterm shares selectionForeground across focused/unfocused selections;
    // keep the same background so brand foregrounds remain legible in both.
    selectionInactiveBackground: selectionBackground,
  };
}

export function readTerminalTheme(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  // The default canvas color space is sRGB, including on P3 displays. Reading
  // its pixel converts hex/rgb/hsl/oklch/display-p3/color-mix to xterm-safe hex.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return resolveTerminalTheme((token) => {
    const value = styles.getPropertyValue(token).trim();
    if (!context || !value || !CSS.supports("color", value) || /^(inherit|initial|unset|revert(?:-layer)?|currentcolor)$/i.test(value)) return null;
    context.clearRect(0, 0, 1, 1);
    // Two sentinels detect a color accepted by CSS but unsupported by canvas;
    // invalid fillStyle assignments otherwise silently retain the previous fill.
    context.fillStyle = "#010203";
    context.fillStyle = value;
    const first = context.fillStyle;
    context.fillStyle = "#040506";
    context.fillStyle = value;
    if (context.fillStyle !== first) return null;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a];
  }, styles.colorScheme === "dark");
}

export function observeTerminalTheme(element: HTMLElement, update: (theme: ITheme) => void): () => void {
  let frame: number | undefined;
  const refresh = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      update(readTerminalTheme(element));
    });
  };
  // theme.ts changes data-theme/style; brand-theme.tsx changes root style and
  // data-brand-accent. Ancestors also cover locally scoped palette overrides.
  const observer = new MutationObserver(refresh);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-brand-accent"] });
  }
  const gamut = matchMedia("(color-gamut: p3)");
  gamut.addEventListener("change", refresh);
  return () => {
    observer.disconnect();
    gamut.removeEventListener("change", refresh);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
