const languages = new Set(["en", "ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es", "ru"]);

/** 只从可信主窗口读取已应用的语言/主题，不读取任何 storage 或 bootstrap 凭据。 */
export async function readFileWindowAppearance(window, fallback = { lang: "en", theme: "light" }) {
  const sanitize = (value) => ({
    lang: languages.has(value?.lang) ? value.lang : "en",
    theme: value?.theme === "dark" ? "dark" : "light",
  });
  const defaults = sanitize(fallback);
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return defaults;
  let timer;
  try {
    const value = await Promise.race([
      window.webContents.executeJavaScript(`(() => ({ lang: document.documentElement.lang, theme: document.documentElement.dataset.theme }))()`),
      new Promise((resolve) => { timer = setTimeout(() => resolve(defaults), 2000); }),
    ]);
    if (window.isDestroyed() || window.webContents.isDestroyed()) return defaults;
    return sanitize(value);
  } catch { return defaults; }
  finally { clearTimeout(timer); }
}
