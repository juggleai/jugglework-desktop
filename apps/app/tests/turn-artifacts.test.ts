import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { deriveOpenTargets, type OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import {
  canDisplayArtifact,
  artifactsWithTurnDiffs,
  getArtifactFileReferences,
  getArtifactsFromMessages,
} from "../src/lib/artifacts";
import {
  resolveFileReference,
  splitFileReferences,
} from "../src/lib/file-references";
import {
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
} from "../src/components/markdown/markdown-primitive";

const output = (
  path: string,
  id = path,
  state = "output-available",
): UIMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "write",
      toolCallId: id,
      state,
      input: { filePath: path, content: "test" },
      output: "saved",
    } as UIMessage["parts"][number],
  ],
});
const target = (path: string, size = 0): OpenTarget => ({
  id: `file:${path}`,
  kind: "file",
  value: path,
  name: path.split("/").at(-1)!,
  preview: "document",
  confidence: 95,
  reason: "write",
  exists: true,
  size,
});
const options = {
  includeTargetFallbacks: false,
  deliverablesOnly: true,
  stableOrder: true,
};

describe("turn artifact delivery", () => {
  test("recovers relative paths and counts from successful edits when the turn summary is empty", () => {
    const edit = (callID: string, patch: string, type = "update"): UIMessage => {
      const part: ToolPart = { id: callID, sessionID: "s", messageID: "a", type: "tool", tool: "apply_patch", callID,
        state: { status: "completed", input: {}, output: "Success", title: "Patched", time: { start: 1, end: 2 }, metadata: {
          files: [{ filePath: "/repo/src/main.ts", relativePath: "repo/src/main.ts", type, patch }], diagnostics: { ignored: true },
        } } };
      return { id: callID, role: "assistant", parts: [parseDynamicToolUIPart(part)!] };
    };
    const first = edit("call-1", "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra");
    const second = edit("call-2", "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-new\n+updated");
    const turn: UIMessage = { id: "user", role: "user", parts: [], metadata: { opencode: { fileDiffs: [] } } };
    const result = artifactsWithTurnDiffs([], turn, [first, first, second], "/repo");
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("src/main.ts");
    expect(result[0]?.change).toMatchObject({ additions: 3, deletions: 2, source: "edits" });
    expect(result[0]?.change?.patch).not.toContain("+++ b/");
    const authoritative = { ...turn, metadata: { opencode: { fileDiffs: [{ file: "src/main.ts", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+updated\n+extra" }] } } };
    expect(artifactsWithTurnDiffs([], authoritative, [first, second], "/repo")[0]?.change).toMatchObject({ additions: 2, deletions: 1, source: "snapshot" });
    const zero = { ...turn, metadata: { opencode: { fileDiffs: [{ file: "src/main.ts", additions: 0, deletions: 0 }] } } };
    expect(artifactsWithTurnDiffs([], zero, [first, second], "/repo")[0]?.change).toBeUndefined();
    expect(artifactsWithTurnDiffs([], turn, [edit("delete", "@@ -1 +0,0 @@\n-old", "delete")], "/repo")[0]?.legacy_target.exists).toBe(false);
  });

  test("retains validated edit metadata but never promotes failed or running tools to changes", () => {
    const part: ToolPart = { id: "edit", sessionID: "s", messageID: "a", type: "tool", tool: "edit", callID: "edit", state: {
      status: "completed", input: { filePath: "/repo/a.ts" }, output: "ok", title: "Edit", time: { start: 1, end: 2 },
      metadata: { filediff: { file: "/repo/a.ts", additions: 5, deletions: 2, unknown: { huge: true } }, diagnostics: { huge: true } },
    } };
    const completed = parseDynamicToolUIPart(part)!;
    expect(completed.callProviderMetadata?.opencode?.toolMetadata).toMatchObject({ filediff: { file: "/repo/a.ts", additions: 5, deletions: 2 } });
    expect(JSON.stringify(completed)).not.toContain("huge");
    const message: UIMessage = { id: "assistant", role: "assistant", parts: [completed] };
    expect(artifactsWithTurnDiffs([], undefined, [message], "/repo")[0]?.change).toMatchObject({ additions: 5, deletions: 2, patch: "" });
    for (const state of ["output-error", "input-streaming"] as const) {
      expect(artifactsWithTurnDiffs([], undefined, [{ ...message, parts: [{ ...completed, state } as UIMessage["parts"][number]] }], "/repo")).toEqual([]);
    }
  });
  test("merges only this turn's text diffs and retains binary files without fabricated counts", () => {
    const existing = getArtifactsFromMessages([output("docs/report.md")], [target("docs/report.md")], options);
    const message: UIMessage = { id: "turn-1", role: "user", parts: [], metadata: { opencode: { fileDiffs: [
      { file: "docs/report.md", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+new\n+line" },
      { file: "src/main.ts", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export {}" },
      { file: "docs/report.docx", additions: 0, deletions: 0, patch: "Binary files a and b differ" },
      { file: "removed.txt", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-old", status: "deleted" },
    ] } } };
    const result = artifactsWithTurnDiffs(existing, message);
    expect(result).toHaveLength(4);
    expect(result[0]!.id).toBe(existing[0]!.id);
    expect(result[0]!.change?.additions).toBe(2);
    expect(result[1]!.path).toBe("src/main.ts");
    expect(result[2]!.change).toBeUndefined();
    expect(result[3]!.legacy_target.exists).toBe(false);
    expect(artifactsWithTurnDiffs(existing, { id: "other-turn", role: "user", parts: [] })).toEqual(existing);
  });
  test("retains missing historical successful writes without promoting unconfirmed file claims", () => {
    const missing = { ...target("removed.docx"), exists: false };
    const [written] = getArtifactsFromMessages(
      [output("removed.docx")],
      [missing],
      options,
    );
    expect(canDisplayArtifact(written!)).toBe(true);
    const [claim] = getArtifactsFromMessages(
      [
        {
          id: "claim",
          role: "assistant",
          parts: [{ type: "text", text: "Created removed.docx" }],
        },
      ],
      [missing],
      options,
    );
    expect(canDisplayArtifact(claim!)).toBe(false);
  });
  test("collects successful process outputs without a final filename, preserves case and first order", () => {
    const targets = [
      target("报告/Plan Q1.docx", 13),
      target("报告/plan Q1.docx", 0),
      target("other.pptx"),
    ];
    const messages = [
      output("/tmp/workspace/报告/Plan Q1.docx"),
      output("报告/plan Q1.docx"),
      output("报告/Plan Q1.docx", "update"),
      output("src/widget.tsx"),
      output("failed.docx", "failure", "output-error"),
    ];
    const artifacts = getArtifactsFromMessages(messages, targets, options);
    expect(artifacts.map((item) => item.path)).toEqual([
      "报告/Plan Q1.docx",
      "报告/plan Q1.docx",
    ]);
    expect(artifacts.map((item) => item.sizeBytes)).toEqual([13, 0]);
  });

  test("does not add another turn's targets or user attachments", () => {
    const messages: UIMessage[] = [
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Created previous.docx" }],
      },
      output("current.docx"),
    ];
    expect(
      getArtifactsFromMessages(
        messages,
        [target("previous.docx"), target("current.docx")],
        options,
      ).map((item) => item.path),
    ).toEqual(["current.docx"]);
  });

  test("does not present an existing file as delivered after a failed write or a read-only mention", () => {
    const messages: UIMessage[] = [
      output("previous.docx", "failure", "output-error"),
      {
        id: "summary",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "参考文件 previous.docx。生成 failed.docx 失败。",
          },
        ],
      },
    ];
    expect(
      getArtifactsFromMessages(
        messages,
        [target("previous.docx"), target("failed.docx")],
        options,
      ),
    ).toEqual([]);
    const legacySummary: UIMessage = {
      id: "legacy",
      role: "assistant",
      parts: [{ type: "text", text: "Created previous.docx" }],
    };
    expect(
      getArtifactsFromMessages(
        [messages[0]!, legacySummary],
        [target("previous.docx")],
        options,
      ),
    ).toEqual([]);
  });

  test("supports Chinese and space-containing names in summary candidates", () => {
    const messages: UIMessage[] = [
      {
        id: "summary",
        role: "assistant",
        parts: [{ type: "text", text: "已生成 `季度报告 Q1.docx`。" }],
      },
    ];
    const artifacts = getArtifactsFromMessages(
      messages,
      [target("季度报告 Q1.docx")],
      options,
    );
    expect(
      artifacts.some(
        (item) => item.path === "季度报告 Q1.docx" && item.legacy_target.exists,
      ),
    ).toBe(true);
  });
});

describe("scoped file references", () => {
  test("PPTX 普通引用经过候选确认后显示链接，只读轮次不生成产物卡片", async () => {
    const text = "只读核对结果：\n- 文件：演示/季度汇报.pptx\n- 另一个文件：`演示/季度汇报 Q1.PPTX`\n- 文件不存在：missing.pptx\n- 页数：2";
    const messages: UIMessage[] = [{ id: "ppt-summary", role: "assistant", parts: [{ type: "text", text }] }];
    const files = [target("演示/季度汇报.pptx"), target("演示/季度汇报 Q1.PPTX")];
    const candidates = deriveOpenTargets(messages, { includeFileMentions: true });
    // 复现实际边界：只有消息提取到的路径才会送 Server 确认。
    const confirmed = candidates.map((candidate) => ({ ...candidate, exists: files.some((file) => file.value === candidate.value) }));
    expect(confirmed.filter((item) => item.exists).map((item) => item.value).sort()).toEqual(files.map((file) => file.value).sort());
    const refs = getArtifactFileReferences(messages, [...confirmed, target("unmentioned.pptx")], []);
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.preview === "slides")).toBe(true);
    for (const html of [renderMarkdownHtml(text, "chat", refs), await renderHighlightedMarkdownHtml(text, "chat", refs)]) {
      expect(html.match(/data-jugglework-artifact-link=/g)).toHaveLength(2);
      expect(html).toContain('data-jugglework-link-href="演示/季度汇报.pptx"');
      expect(html).toContain('data-jugglework-link-href="演示/季度汇报 Q1.PPTX"');
      expect(html).toContain("text-indigo-10");
    }
    expect(getArtifactsFromMessages(messages, confirmed, options)).toEqual([]);
  });

  test("CSV 总结文件名和行内代码使用可打开的表格引用", () => {
    const messages: UIMessage[] = [{ id: "csv-summary", role: "assistant", parts: [{ type: "text", text: "已生成 客户.csv，文件：`客户.csv`。" }] }];
    const refs = getArtifactFileReferences(messages, [{ ...target("客户.csv"), preview: "sheet" }], []);
    const html = renderMarkdownHtml((messages[0]!.parts[0] as { text: string }).text, "chat", refs);
    expect(refs).toHaveLength(1);
    expect(html.match(/data-jugglework-artifact-link=/g)).toHaveLength(2);
  });
  test("旧轮次和空交付记录仍将已确认的 Word、Excel 正文转成链接", () => {
    const messages: UIMessage[] = [{ id: "summary", role: "assistant", parts: [{ type: "text", text: "已创建演示用 Word 文档：\n- 文件： demo.docx\n\n已生成 Excel 文件：`客户汇总.xlsx`" }] }];
    const refs = getArtifactFileReferences(messages, [target("demo.docx"), target("客户汇总.xlsx"), target("other.docx")], []);
    expect(refs.map((item) => item.value)).toEqual(["demo.docx", "客户汇总.xlsx"]);
    const html = renderMarkdownHtml((messages[0]!.parts[0] as { text: string }).text, "chat", refs);
    expect(html.match(/data-jugglework-artifact-link=/g)).toHaveLength(2);
    expect(getArtifactFileReferences(messages, [{ ...target("demo.docx"), exists: false }], [])).toEqual([]);
  });

  test("keeps ambiguous basenames and case-distinct identities separate", () => {
    const targets = [
      target("a/Report.docx"),
      target("b/Report.docx"),
      target("a/report.docx"),
    ];
    expect(resolveFileReference("Report.docx", targets)).toBeNull();
    expect(resolveFileReference("a/Report.docx", targets)?.value).toBe(
      "a/Report.docx",
    );
    expect(resolveFileReference("report.docx", targets)?.value).toBe(
      "a/report.docx",
    );
    expect(
      splitFileReferences("Report.docx and a/Report.docx", targets)
        .filter((part) => part.target)
        .map((part) => part.target!.value),
    ).toEqual(["a/Report.docx"]);
  });

  test("renders text, inline code and markdown links without nesting anchors or touching fences and URLs", async () => {
    const targets = [target("报告 Q1.docx")];
    const markdown =
      "文件 报告 Q1.docx 与 `报告 Q1.docx`，以及 [报告 Q1.docx](<./报告 Q1.docx>)。\n\n[网站](https://example.com/报告)\n\n```text\n报告 Q1.docx\n```";
    for (const html of [
      renderMarkdownHtml(markdown, "chat", targets),
      await renderHighlightedMarkdownHtml(markdown, "chat", targets),
    ]) {
      expect(html.match(/data-jugglework-artifact-link=/g)?.length).toBe(3);
      expect(html).not.toMatch(/<a[^>]*>[^<]*<a/);
      expect(html).toContain('href="https://example.com/');
      expect(html).toContain("报告 Q1.docx");
    }
    expect(
      renderMarkdownHtml(
        "[外部文件](https://example.com/报告.docx)",
        "chat",
        targets,
      ),
    ).not.toContain("data-jugglework-artifact-link");
  });

  test("各类超链接只显示链接色文字，不带图标、按钮、边框和背景", async () => {
    const targets = [target("报告.docx"), { ...target("数据.csv"), preview: "sheet" as const }, { ...target("汇报.pptx"), preview: "slides" as const }];
    const markdown = '报告.docx、`数据.csv`、[`汇报.pptx`](./汇报.pptx)、[其他文件](./other.txt)、[`网站`](https://example.com)';
    for (const html of [renderMarkdownHtml(markdown, "chat", targets), await renderHighlightedMarkdownHtml(markdown, "chat", targets)]) {
      expect(html.match(/<a /g)).toHaveLength(5);
      expect(html).not.toMatch(/<svg|<button|<code|bg-|border|rounded|link-chevron/);
      expect(html.match(/class="text-indigo-10 /g)).toHaveLength(5);
      expect(html.match(/ no-underline /g)).toHaveLength(5);
      expect(html).not.toMatch(/class="[^"]*(?:^|\s)underline(?:\s|$)|hover:underline|underline-offset/);
    }
  });

  test("does not convert missing files or longer names, and escapes literal file names", () => {
    const targets = [
      target("Report.docx"),
      { ...target("missing.docx"), exists: false },
    ];
    expect(
      splitFileReferences("LongReport.docx and missing.docx", targets).some(
        (part) => part.target,
      ),
    ).toBe(false);
    const name = 'report"><img src=x>.docx';
    const html = renderMarkdownHtml(`\`${name}\``, "chat", [target(name)]);
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("data-jugglework-artifact-link");
  });
});
