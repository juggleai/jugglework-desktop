import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { sourceLanguage } from "../src/react-app/domains/session/artifacts/source-language";

function coloredText(state: EditorState) {
  const colored: Array<{ text: string; style: string }> = [];
  highlightTree(syntaxTree(state), { style: tags => highlightingFor(state, tags) }, (from, to, style) => {
    colored.push({ text: state.sliceDoc(from, to), style });
  });
  return colored;
}

test("editable TSX recognizes keywords, strings and JSX tags without changing the source", () => {
  const source = 'export const greeting: string = "hello"; const view = <div>{greeting}</div>';
  const state = EditorState.create({ doc: source, extensions: [sourceLanguage("greeting.tsx")] });
  const colored = coloredText(state);
  expect(colored).toContainEqual({ text: "export", style: "source-code-keyword" });
  expect(colored).toContainEqual({ text: '"hello"', style: "source-code-string" });
  expect(colored.some(token => token.text === "div" && token.style === "source-code-tag")).toBe(true);
  expect(state.doc.toString()).toBe(source);
});

test("JSON numbers and unknown plain text use the appropriate editor mode", () => {
  const state = EditorState.create({ doc: '{"count": 42}', extensions: [sourceLanguage("data.json")] });
  expect(coloredText(state)).toContainEqual({ text: "42", style: "source-code-constant" });
  const plain = EditorState.create({ doc: "const plain = 42", extensions: [sourceLanguage("note.txt")] });
  expect(coloredText(plain)).toEqual([]);
});
