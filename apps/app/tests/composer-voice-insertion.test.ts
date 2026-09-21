import { describe, expect, test } from "bun:test";
import {
  insertTextAtSelection,
  type TextInsertionSelection,
} from "../src/react-app/domains/session/surface/composer/editor-insertion";

function setup(value: string, start: number | null, end = start) {
  let text = value;
  let selection: TextInsertionSelection | null = start === null ? null : {
    insertText(inserted) {
      text = `${text.slice(0, start)}${inserted}${text.slice(end ?? start)}`;
    },
  };
  const adapter = {
    getSelection: () => selection,
    isRangeSelection: (candidate: unknown): candidate is TextInsertionSelection => candidate === selection && selection !== null,
    selectEnd: () => {
      const offset = text.length;
      selection = {
        insertText(inserted) {
          text = `${text.slice(0, offset)}${inserted}`;
        },
      };
    },
  };
  return { adapter, text: () => text };
}

describe("composer voice transcript insertion", () => {
  test("inserts at the current caret", () => {
    const editor = setup("hello world", 6);
    insertTextAtSelection("spoken ", editor.adapter);
    expect(editor.text()).toBe("hello spoken world");
  });

  test("replaces selected text", () => {
    const editor = setup("hello world", 0, 5);
    insertTextAtSelection("你好", editor.adapter);
    expect(editor.text()).toBe("你好 world");
  });

  test("appends when no selection remains", () => {
    const editor = setup("draft", null);
    insertTextAtSelection(" result", editor.adapter);
    expect(editor.text()).toBe("draft result");
  });
});
