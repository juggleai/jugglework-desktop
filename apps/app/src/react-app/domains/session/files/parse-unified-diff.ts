/**
 * unified diff 中的一行
 *
 * @param kind 行类型：新增、删除、上下文、以及 `\ No newline at end of file` 之类的元信息
 * @param content 行内容（已去掉行首的 +/-/空格标记）
 * @param oldLine 变更前的行号，新增行为 null
 * @param newLine 变更后的行号，删除行为 null
 */
export type DiffLine = {
  kind: "add" | "del" | "context" | "meta";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

/**
 * unified diff 中的一个 hunk
 *
 * @param header hunk 头（`@@ -1,4 +1,6 @@`），无头时为空串
 * @param lines hunk 内的行
 */
export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

const HUNK_HEADER = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * 把 unified diff 文本解析成 hunk / 行结构
 *
 * TIPS: 引擎返回的 patch 前面带 `diff --git`、`index`、`---`、`+++` 等文件头，
 * 首个 `@@` 之前的内容全部丢弃；没有任何 `@@` 时（例如二进制文件的
 * "Binary files differ"）返回空数组，由调用方展示对应空态。
 *
 * @param patch unified diff 文本
 * @returns 解析出的 hunk 列表
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);

    if (header) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }

    if (!current) continue;

    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", content: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", content: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("\\")) {
      current.lines.push({ kind: "meta", content: raw, oldLine: null, newLine: null });
      continue;
    }

    // 上下文行以空格开头；patch 末尾可能出现空字符串行，两者都按上下文处理
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;

    if (content === "" && raw === "") {
      continue;
    }

    current.lines.push({ kind: "context", content, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return hunks;
}

/**
 * 统计一个 patch 解析后的总行数，用于超长 diff 的折叠判断
 *
 * @param hunks 解析后的 hunk 列表
 */
export function countDiffLines(hunks: DiffHunk[]): number {
  return hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}
