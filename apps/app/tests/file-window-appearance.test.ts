import { expect, mock, test } from "bun:test";
import type { FileWindowState } from "@jugglework/types/file-window";
import { applyFileWindowAppearance } from "../src/app/lib/file-window-appearance";
import { getResolvedThemeMode, subscribeToTheme } from "../src/app/theme";
import { currentLocale, subscribeLocale } from "../src/i18n";

test("file appearance applies host theme and locale without storage or desktop credential access", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, setAttribute: mock() };
  const storageAccess = mock(() => { throw new Error("file appearance must not access storage"); });
  const desktopAccess = mock(() => { throw new Error("file appearance must not access credentials or native theme"); });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    get localStorage() { return storageAccess(); },
    get __JUGGLEWORK_ELECTRON__() { return desktopAccess(); },
  } });
  const themeChanged = mock(), localeChanged = mock();
  const stopTheme = subscribeToTheme(themeChanged), stopLocale = subscribeLocale(localeChanged);
  try {
    for (const appearance of [{ theme: "dark", lang: "zh" }, { theme: "light", lang: "en" }] as const) {
      applyFileWindowAppearance(appearance);
      expect(root.dataset.theme).toBe(appearance.theme);
      expect(root.style.colorScheme).toBe(appearance.theme);
      expect(getResolvedThemeMode()).toBe(appearance.theme);
      expect(currentLocale()).toBe(appearance.lang);
      expect(root.setAttribute).toHaveBeenLastCalledWith("lang", appearance.lang);
    }
    expect(themeChanged).toHaveBeenCalledTimes(2);
    expect(localeChanged).toHaveBeenCalledTimes(2);
    for (const appearance of [undefined, { theme: "unsafe", lang: "invalid" } as unknown as FileWindowState["appearance"]]) {
      applyFileWindowAppearance(appearance);
      expect(root.dataset.theme).toBe("dark");
      expect(currentLocale()).toBeOneOf(["en", "zh"]);
      expect(root.setAttribute).toHaveBeenLastCalledWith("lang", currentLocale());
    }
    expect(storageAccess).not.toHaveBeenCalled();
    expect(desktopAccess).not.toHaveBeenCalled();
  } finally {
    stopTheme(); stopLocale();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});
