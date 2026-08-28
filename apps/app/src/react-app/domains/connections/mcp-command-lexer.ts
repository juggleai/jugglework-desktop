/**
 * MCP 启动命令的词法解析。
 *
 * TIPS: 只解析 POSIX shell 的引号与转义子集，不实现变量展开、`~` 展开、管道与重定向——
 * 这些在 MCP 启动命令里没有合法用途，实现它们等于把 shell 语义引入一条不过 shell 的执行路径。
 * 解析结果以 string[] 交给 opencode 直接 spawn，因此 `;rm -rf ~/x` 只会成为一个普通 argv 元素。
 * MCP 官方 server.schema.json 在 Argument 定义中专门警告了命令注入风险，此处的边界即为其对策。
 */

/** 词法解析失败的原因。 */
export type LexCommandError = "unterminated_quote";

/**
 * 词法解析结果。
 * @param argv 切分后的命令与参数数组
 * @param error 解析失败原因，成功时为 null
 */
export type LexCommandResult = {
  argv: string[];
  error: LexCommandError | null;
};

/**
 * 把用户输入的启动命令切分为 argv 数组。
 * @param input 用户输入的命令文本
 * @returns 成功时 error 为 null；引号未闭合时 argv 为已解析部分且 error 为 `unterminated_quote`
 */
export function lexCommand(input: string): LexCommandResult {
  const argv: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote === "'") {
      // 单引号内一切字面量，包括反斜杠与双引号。
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        const next = input[index + 1];
        // 双引号内只有 \" 与 \\ 是转义，其余保留反斜杠本身。
        if (next === '"' || next === "\\") {
          current += next;
          index += 1;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasCurrent = true;
      continue;
    }

    if (char === "\\") {
      const next = input[index + 1];
      if (next !== undefined) {
        current += next;
        hasCurrent = true;
        index += 1;
      }
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (hasCurrent) {
        argv.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }

    current += char;
    hasCurrent = true;
  }

  if (hasCurrent) argv.push(current);

  return { argv, error: quote ? "unterminated_quote" : null };
}

/**
 * 把 argv 数组还原为可编辑的命令文本，含空格或引号的元素会被加引号。
 * @param argv 命令与参数数组
 */
export function formatCommand(argv: string[]): string {
  return argv
    .map((part) => {
      if (part === "") return '""';
      if (!/[\s"'\\]/.test(part)) return part;
      return `"${part.replace(/(["\\])/g, "\\$1")}"`;
    })
    .join(" ");
}
