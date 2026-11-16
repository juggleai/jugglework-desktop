/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { diffLanguage, highlightDiffHunks } from "../src/react-app/domains/session/files/diff-highlight";
import { DiffCode } from "../src/react-app/domains/session/files/diff-code";
import { parseUnifiedDiff } from "../src/react-app/domains/session/files/parse-unified-diff";

test("recognizes common source and configuration files and leaves unknown files plain", () => {
  for (const [path, language] of [["src/a.tsx", "tsx"], ["a.ts", "typescript"], ["run.py", "python"], ["settings.json", "json"], ["ci.yml", "yaml"], ["Dockerfile", "dockerfile"]]) expect(diffLanguage(path!)).toBe(language);
  expect(diffLanguage("data.unknown-extension")).toBeNull();
});

test("separates old and new syntax state without changing or executing the source", async () => {
  const hunks = parseUnifiedDiff('@@ -1 +1 @@\n-/* removed comment\n+const answer = "<script>alert(1)</script>"');
  const [removed, added] = hunks[0]!.lines;
  const tokens = await highlightDiffHunks("sample.ts", hunks);
  expect(tokens.get(added!)!.map(token => token.content).join("")).toBe(added!.content);
  expect(tokens.get(removed!)!.map(token => token.content).join("")).toBe(removed!.content);
  expect(tokens.get(added!)![0]!.light).not.toBe(tokens.get(removed!)![0]!.light);
  expect(tokens.get(added!)![0]!.dark).toBeTruthy();
  const html = renderToStaticMarkup(<DiffCode line={added!} tokens={tokens} />);
  expect(html).toContain("diff-code-token");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect((await highlightDiffHunks("sample.unknown-extension", hunks)).size).toBe(0);
});
