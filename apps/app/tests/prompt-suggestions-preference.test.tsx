/** @jsxImportSource react */
import * as React from "react";
import { expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { LocalProvider, useLocal, DEFAULT_PROMPT_SUGGESTIONS_ENABLED } from "../src/react-app/kernel/local-provider";
import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { LANGUAGES, currentLocale, setLocale, t } from "../src/i18n";

mock.module("../src/components/ui/switch", () => ({ Switch: (props: Record<string, unknown>) => <button {...props} /> }));
mock.module("../src/components/ui/select", () => ({
  Select: () => null, SelectContent: () => null, SelectGroup: () => null,
  SelectItem: () => null, SelectTrigger: () => null, SelectValue: () => null,
}));
const { PreferencesView } = await import("../src/react-app/domains/settings/pages/preferences-view");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 只读写内存中的偏好替身，避免测试访问本机用户配置。 */
async function withPreferences(stored: unknown, run: (storage: Map<string, string>) => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  if (stored !== undefined) storage.set(LOCAL_PREFERENCES_KEY, JSON.stringify(stored));
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } } });
  try { await run(storage); } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function readEnabled(stored: unknown, setup?: (storage: Map<string, string>) => void) {
  let enabled: boolean | undefined;
  await withPreferences(stored, async (storage) => {
    setup?.(storage);
    let local!: ReturnType<typeof useLocal>;
    function Probe() { local = useLocal(); return null; }
    let view!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => { view = TestRenderer.create(<LocalProvider persist={false}><Probe /></LocalProvider>); });
      enabled = local.prefs.promptSuggestionsEnabled;
    } finally { await act(async () => { view?.unmount(); }); }
  });
  return enabled;
}

test.each([undefined, {}, { promptSuggestionsEnabled: false }, { promptSuggestionsEnabled: "true" }, { promptSuggestionsEnabled: null }])("新安装及升级（含旧版默认写入的 false）默认开启建议：%j", async (stored) => {
  expect(DEFAULT_PROMPT_SUGGESTIONS_ENABLED).toBe(true);
  expect(await readEnabled(stored)).toBe(true);
});

test("迁移完成后，用户主动关闭的选择会保留", async () => {
  const migrated = (storage: Map<string, string>) => storage.set("jugglework.promptSuggestions.defaultOnMigrated", "1");
  expect(await readEnabled({ promptSuggestionsEnabled: false }, migrated)).toBe(false);
  expect(await readEnabled({ promptSuggestionsEnabled: "bad" }, migrated)).toBe(true);
});

test("全局开关说明费用及 Tab 不发送，更新后持久化并在重新挂载时保留", async () => {
  await withPreferences({ promptSuggestionsEnabled: true, showThinking: false }, async (storage) => {
    let local!: ReturnType<typeof useLocal>;
    function Preferences() {
      local = useLocal();
      return <PreferencesView busy={false} showThinking={local.prefs.showThinking} onToggleShowThinking={() => {}}
        promptSuggestionsEnabled={local.prefs.promptSuggestionsEnabled}
        onTogglePromptSuggestions={() => local.setPrefs(previous => ({ ...previous, promptSuggestionsEnabled: !previous.promptSuggestionsEnabled }))}
        autoCompactContext={true} autoCompactContextBusy={false} onToggleAutoCompactContext={() => {}}
        analyticsEnabled={true} onToggleAnalytics={() => {}} desktopNotifications="off" onDesktopNotificationsChange={() => {}}
        memoryEnabled={false} onToggleMemory={() => {}} />;
    }
    const previousLocale = currentLocale();
    setLocale("zh");
    let view!: TestRenderer.ReactTestRenderer;
    try {
      const render = () => <LocalProvider><Preferences /></LocalProvider>;
      await act(async () => { view = TestRenderer.create(render()); });
      const toggle = () => view.root.findByProps({ "aria-label": "下一轮输入建议", checked: local.prefs.promptSuggestionsEnabled });
      expect(toggle().props.checked).toBe(true);
      const descriptionId = toggle().props["aria-describedby"];
      expect(view.root.findByProps({ id: descriptionId }).children.join("")).toBe("在回复结束后，使用当前会话模型生成下一轮输入建议；可能产生额外模型费用。按 Tab 填入后可编辑，不会自动发送。");
      await act(async () => { toggle().props.onCheckedChange(false); });
      expect(toggle().props.checked).toBe(false);
      expect(local.prefs.showThinking).toBe(false);
      expect(JSON.parse(storage.get(LOCAL_PREFERENCES_KEY)!)).toMatchObject({ promptSuggestionsEnabled: false, showThinking: false });
      await act(async () => { view.unmount(); });
      await act(async () => { view = TestRenderer.create(render()); });
      expect(toggle().props.checked).toBe(false);
      await act(async () => { toggle().props.onCheckedChange(true); });
      expect(JSON.parse(storage.get(LOCAL_PREFERENCES_KEY)!)).toMatchObject({ promptSuggestionsEnabled: true });
    } finally {
      await act(async () => { view?.unmount(); });
      setLocale(previousLocale);
    }
  });
});

test("所有现有语言包提供设置说明和读屏提示，无可见 Tab 提示", async () => {
  const previousLocale = currentLocale();
  try {
    for (const language of LANGUAGES) {
      const strings = (await import(`../src/i18n/locales/${language}.ts`)).default;
      setLocale(language);
      for (const key of ["settings.prompt_suggestions", "settings.prompt_suggestions_desc", "composer.prompt_suggestion.available_hint"]) {
        expect(typeof strings[key]).toBe("string");
        expect(strings[key].length).toBeGreaterThan(0);
        expect(t(key)).toBe(strings[key]);
      }
      expect(strings["composer.prompt_suggestion.accept_hint"]).toBeUndefined();
    }
  } finally { setLocale(previousLocale); }
});
