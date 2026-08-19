import { describe, expect, test } from "bun:test";

import { countDiffLines, parseUnifiedDiff } from "../src/react-app/domains/session/files/parse-unified-diff";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,2 +21,2 @@",
  "-old tail",
  "+new tail",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedDiff", () => {
  test("splits hunks and drops the file header", () => {
    const hunks = parseUnifiedDiff(PATCH);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,4 +1,5 @@");
  });

  test("assigns old and new line numbers", () => {
    const [first] = parseUnifiedDiff(PATCH);

    expect(first?.lines).toEqual([
      { kind: "context", content: "const a = 1;", oldLine: 1, newLine: 1 },
      { kind: "del", content: "const b = 2;", oldLine: 2, newLine: null },
      { kind: "add", content: "const b = 3;", oldLine: null, newLine: 2 },
      { kind: "add", content: "const c = 4;", oldLine: null, newLine: 3 },
      { kind: "context", content: "const d = 5;", oldLine: 3, newLine: 4 },
    ]);
  });

  test("keeps no-newline markers as meta lines", () => {
    const hunks = parseUnifiedDiff(PATCH);
    const last = hunks[1]?.lines.at(-1);

    expect(last?.kind).toBe("meta");
    expect(last?.content).toBe("\\ No newline at end of file");
  });

  test("returns no hunks for patches without a hunk header", () => {
    expect(parseUnifiedDiff("Binary files a/logo.png and b/logo.png differ")).toEqual([]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("counts parsed lines", () => {
    expect(countDiffLines(parseUnifiedDiff(PATCH))).toBe(8);
  });
});
