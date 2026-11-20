import { expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, createEditor } from "lexical";
import { insertPastedText } from "../src/react-app/domains/session/surface/composer/pasted-text-insertion";

test("expanded paste preserves whitespace and subsequent typing uses ordinary text", () => {
  const editor = createEditor();
  editor.update(() => {
    const chip = $createTextNode("placeholder").setMode("token");
    $getRoot().append($createParagraphNode().append(chip));
    chip.select(0, chip.getTextContentSize());
    expect(insertPastedText("first\r\nsecond\tthird")).toBe(true);
  }, { discrete: true });
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("Expected caret after paste");
    selection.insertText(" continued");
  }, { discrete: true });
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe("first\nsecond\tthird continued");
    for (const node of $getRoot().getAllTextNodes()) expect(node.getStyle()).toBe("");
  });
});
