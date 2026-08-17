import { describe, expect, test } from "bun:test";

import { formatCommand, lexCommand } from "../src/react-app/domains/connections/mcp-command-lexer";

describe("lexCommand", () => {
  test("按空白切分普通命令", () => {
    expect(lexCommand("npx -y @modelcontextprotocol/server-postgres")).toEqual({
      argv: ["npx", "-y", "@modelcontextprotocol/server-postgres"],
      error: null,
    });
  });

  test("双引号内保留空格", () => {
    const result = lexCommand('npx -y foo --dsn "postgres://a b/c"');
    expect(result.error).toBeNull();
    expect(result.argv).toEqual(["npx", "-y", "foo", "--dsn", "postgres://a b/c"]);
  });

  test("单引号内一切字面量", () => {
    const result = lexCommand(`foo --pass 'a"b\\c'`);
    expect(result.error).toBeNull();
    expect(result.argv).toEqual(["foo", "--pass", 'a"b\\c']);
  });

  test("双引号内支持 \\\" 与 \\\\ 转义", () => {
    const result = lexCommand('foo "say \\"hi\\"" "back\\\\slash"');
    expect(result.error).toBeNull();
    expect(result.argv).toEqual(["foo", 'say "hi"', "back\\slash"]);
  });

  test("引号外反斜杠转义空格", () => {
    const result = lexCommand("foo /tmp/my\\ dir");
    expect(result.error).toBeNull();
    expect(result.argv).toEqual(["foo", "/tmp/my dir"]);
  });

  test("未闭合引号报错", () => {
    const result = lexCommand('npx -y foo --dsn "postgres://a');
    expect(result.error).toBe("unterminated_quote");
  });

  test("注入字符只成为单个 argv 元素", () => {
    const result = lexCommand('npx -y foo ";rm -rf ~/x"');
    expect(result.error).toBeNull();
    expect(result.argv).toEqual(["npx", "-y", "foo", ";rm -rf ~/x"]);
  });

  test("连续空白与首尾空白不产生空元素", () => {
    const result = lexCommand("   npx   -y    foo  ");
    expect(result.argv).toEqual(["npx", "-y", "foo"]);
  });

  test("空输入返回空数组", () => {
    expect(lexCommand("   ")).toEqual({ argv: [], error: null });
  });

  test("空引号产生一个空字符串参数", () => {
    const result = lexCommand('foo ""');
    expect(result.argv).toEqual(["foo", ""]);
  });
});

describe("formatCommand", () => {
  test("含空格的元素被加引号", () => {
    expect(formatCommand(["npx", "-y", "foo", "postgres://a b"])).toBe(
      'npx -y foo "postgres://a b"',
    );
  });

  test("与 lexCommand 互为逆运算", () => {
    const argv = ["npx", "-y", "foo", "postgres://a b/c", 'say "hi"', ";rm -rf x"];
    expect(lexCommand(formatCommand(argv)).argv).toEqual(argv);
  });

  test("空字符串元素还原为一对引号", () => {
    expect(formatCommand(["foo", ""])).toBe('foo ""');
  });
});
