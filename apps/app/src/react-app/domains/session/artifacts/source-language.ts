import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

const colors = HighlightStyle.define([
  { tag: tags.keyword, class: "source-code-keyword" },
  { tag: [tags.string, tags.regexp], class: "source-code-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "source-code-constant" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: "source-code-function",
  },
  { tag: [tags.typeName, tags.className], class: "source-code-type" },
  { tag: tags.tagName, class: "source-code-tag" },
  { tag: tags.comment, class: "source-code-comment" },
]);

/** 按文件名启用 CodeMirror 原生增量解析，未知类型保持纯文本编辑。 */
export function sourceLanguage(filename: string): Extension {
  const extension = filename.toLowerCase().split(".").pop();
  const language =
    extension === "ts" || extension === "tsx"
      ? javascript({ typescript: true, jsx: extension === "tsx" })
      : ["js", "jsx", "mjs", "cjs", "jsonc"].includes(extension ?? "")
        ? javascript({ jsx: extension === "jsx" })
        : extension === "json"
          ? json()
          : extension === "css"
            ? css()
            : ["html", "htm", "vue", "svelte"].includes(extension ?? "")
              ? html()
              : null;
  return language ? [language, syntaxHighlighting(colors)] : [];
}
