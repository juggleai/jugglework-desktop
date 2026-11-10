import { afterEach, expect, test } from "bun:test";

import { setLocale, t } from "../src/i18n";

afterEach(() => setLocale("en"));

test("uses the localized terminal title and controls in Chinese", () => {
  setLocale("zh");
  expect(t("terminal.title")).toBe("终端");
  expect(t("terminal.show")).toBe("显示终端");
  expect(t("terminal.hide")).toBe("隐藏终端");
  expect(t("terminal.shortcut_title")).toBe("终端 (Cmd/Ctrl+J)");
});
