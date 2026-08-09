import { describe, expect, test } from "bun:test";

import {
  resolveModelPickerSubtitle,
} from "../src/react-app/domains/session/modals/model-picker-modal";
import { setLocale, t } from "../src/i18n";

describe("model picker subtitle", () => {
  test("keeps the normal session subtitle by default", () => {
    setLocale("en");
    expect(resolveModelPickerSubtitle(undefined)).toBe("Select a model for this session.");
  });

  test("localizes the unavailable-model recovery subtitle", () => {
    setLocale("zh");
    expect(t("model_picker.unavailable_subtitle")).toBe(
      "你之前使用的模型已不可用，请为此会话选择其他模型。",
    );
    setLocale("en");
  });
});
