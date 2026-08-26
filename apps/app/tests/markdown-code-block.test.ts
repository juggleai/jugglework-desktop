import { describe, expect, test } from "bun:test";

import { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "../src/components/markdown/markdown";
import { renderHighlightedMarkdownHtml as renderPrimitiveHighlightedMarkdownHtml, renderMarkdownHtml as renderPrimitiveMarkdownHtml } from "../src/components/markdown/markdown-primitive";
import { textHighlightParts } from "../src/components/markdown/text-highlights";
import { hasMermaidCodeBlock } from "../src/react-app/domains/session/artifacts/mermaid-diagrams";

const CODE = "const value = 1;\nconsole.log(value);";
const MARKDOWN = `\`\`\`ts\n${CODE}\n\`\`\``;

describe("markdown code blocks", () => {
  test("renders fallback code blocks with subtle theme-aware styling and copy affordance", () => {
    const html = renderMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-jugglework-code-block");
    expect(html).toContain("bg-gray-2/60");
    expect(html).toContain("data-jugglework-code-copy");
    expect(html).toContain("data-jugglework-code-copy-icon");
    expect(html).toContain("data-jugglework-code-copy-check-icon");
    expect(html).toContain("h-7 w-7");
    expect(html).toContain('aria-label="Copy code block"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('title="Copy code block"');
    expect(html).not.toContain(">Copy</span>");
    expect(html).toContain("pt-11");
    expect(html).toContain(CODE.split("\n")[0]);
    expect(html).toContain(CODE.split("\n")[1]);
  });

  test("renders highlighted code blocks with the same copy affordance and dual Shiki themes", async () => {
    const html = await renderHighlightedMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-jugglework-code-block");
    expect(html).toContain("data-jugglework-shiki");
    expect(html).toContain("data-jugglework-code-copy");
    expect(html).toContain("data-jugglework-code-copy-icon");
    expect(html).toContain("data-jugglework-code-copy-check-icon");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("github-light");
    expect(html).toContain("github-dark");
  });

  test("renders surface code blocks without copy controls unless explicitly enabled", async () => {
    const fallbackHtml = renderPrimitiveMarkdownHtml(MARKDOWN, "surface");
    expect(fallbackHtml).toContain("border-dls-border/70");
    expect(fallbackHtml).toContain("bg-gray-1/80");
    expect(fallbackHtml).toContain('class="language-ts"');
    expect(fallbackHtml).not.toContain("data-jugglework-code-copy");

    const highlightedHtml = await renderPrimitiveHighlightedMarkdownHtml(MARKDOWN, "surface");
    expect(highlightedHtml).toContain("data-jugglework-shiki");
    expect(highlightedHtml).toContain("github-light");
    expect(highlightedHtml).not.toContain("github-dark");
    expect(highlightedHtml).not.toContain("data-jugglework-code-copy");
  });

  test("renders copyable surface code blocks with icon feedback markup", async () => {
    const fallbackHtml = renderPrimitiveMarkdownHtml(MARKDOWN, "surface-copyable");
    expect(fallbackHtml).toContain("data-jugglework-code-block");
    expect(fallbackHtml).toContain("data-jugglework-code-copy");
    expect(fallbackHtml).toContain("data-jugglework-code-copy-icon");
    expect(fallbackHtml).toContain("data-jugglework-code-copy-check-icon");
    expect(fallbackHtml).toContain('aria-label="Copy code block"');
    expect(fallbackHtml).toContain("pt-11");

    const highlightedHtml = await renderPrimitiveHighlightedMarkdownHtml(MARKDOWN, "surface-copyable");
    expect(highlightedHtml).toContain("data-jugglework-shiki");
    expect(highlightedHtml).toContain("data-jugglework-code-copy");
  });

  test("leaves Mermaid fences unwrapped for diagram rendering", () => {
    const html = renderPrimitiveMarkdownHtml("```mermaid\nflowchart LR\nA --> B\n```", "surface-copyable");
    expect(html).toContain('class="language-mermaid"');
    expect(html).not.toContain("data-jugglework-code-copy");
  });
});

describe("markdown safety and links", () => {
  test("blocks unsafe markdown link targets and strips raw HTML from surface markdown", () => {
    const html = renderMarkdownHtml(`[bad](javascript:alert(1))`);

    expect(html).toContain('href="#"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(`<img src="x" onerror="alert(1)"><script>alert(1)</script>`, "surface");
    expect(surfaceHtml).not.toContain("onerror");
    expect(surfaceHtml).not.toContain("<script");
  });

  test("keeps chat file link actions separate from simple surface links", () => {
    const markdown = `[Open docs](./docs/readme.md) and [JuggleWork](https://juggle.im)`;
    const chatHtml = renderMarkdownHtml(markdown);
    expect(chatHtml).toContain("data-jugglework-link-chevron");
    expect(chatHtml).toContain("data-jugglework-link-href");
    expect(chatHtml).toContain('href="https://juggle.im"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(markdown, "surface");
    expect(surfaceHtml).not.toContain("data-jugglework-link-chevron");
    expect(surfaceHtml).not.toContain("data-jugglework-link-href");
    expect(surfaceHtml).toContain('href="./docs/readme.md"');
    expect(surfaceHtml).toContain('href="https://juggle.im"');
  });
});

describe("markdown rich blocks", () => {
  test("wraps GFM tables in a horizontally scrollable surface", () => {
    const html = renderPrimitiveMarkdownHtml("| Name | Value |\n| --- | ---: |\n| Alpha | 1 |", "surface");

    expect(html).toContain("data-jugglework-markdown-table");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-max");
    expect(html).toContain('style="text-align: right"');
  });

  test("detects backtick and tilde Mermaid fences without matching other code", () => {
    expect(hasMermaidCodeBlock("```mermaid\nflowchart LR\nA --> B\n```" )).toBe(true);
    expect(hasMermaidCodeBlock("```Mermaid\nflowchart LR\nA --> B\n```" )).toBe(true);
    expect(hasMermaidCodeBlock("~~~mermaid title\nsequenceDiagram\nA->>B: Hi\n~~~" )).toBe(true);
    expect(hasMermaidCodeBlock("```typescript\nconst mermaid = true\n```" )).toBe(false);
  });
});

describe("markdown text highlighting", () => {
  test("splits matching text without changing the original casing", () => {
    expect(textHighlightParts("Markdown makes marks in markdown.", "MARK")).toEqual([
      { text: "Mark", highlighted: true },
      { text: "down makes ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "s in ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "down.", highlighted: false },
    ]);
  });

  test("treats highlight queries as literal text", () => {
    expect(textHighlightParts("Find a+b and a+b again", "a+b")).toEqual([
      { text: "Find ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " and ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " again", highlighted: false },
    ]);
  });
});
