import type { FileWindowState } from "@jugglework/types/file-window";
import { detectSystemLanguage, initLocale, isLanguage } from "@/i18n";
import { applyHostTheme } from "@/app/theme";

/** 隔离窗口只应用 Main 的白名单外观，不读取或复制主窗口 storage。 */
export function applyFileWindowAppearance(appearance?: FileWindowState["appearance"]) {
  const theme = appearance?.theme === "dark" || appearance?.theme === "light"
    ? appearance.theme
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyHostTheme(theme);
  initLocale(isLanguage(appearance?.lang) ? appearance.lang : detectSystemLanguage());
}
