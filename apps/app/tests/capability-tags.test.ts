import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_INSTRUCTION_RE,
  COMPOSER_TOKEN_SPLIT_RE,
  buildCapabilityInstruction,
  capabilityDefaultDetail,
  composerCapabilityToken,
  fallbackCapabilityPrompt,
  parseCapabilityInstruction,
  parseComposerCapabilityToken,
  replaceComposerCapabilityTokens,
  resolveMcpCapabilitySelection,
  type ComposerCapabilityKind,
} from "../src/react-app/domains/session/surface/composer/capability-tags";

const KINDS: ComposerCapabilityKind[] = ["skill", "cloud-skill", "extension", "mcp", "cloud-mcp"];

describe("草稿 token", () => {
  test("每种能力的 token 都能被分词并解析回来", () => {
    for (const kind of KINDS) {
      const token = composerCapabilityToken(kind, "my-thing");
      const segments = `前置文字 ${token} 后置文字`.split(COMPOSER_TOKEN_SPLIT_RE);
      expect(segments).toContain(token);
      expect(parseComposerCapabilityToken(token)).toEqual({ kind, name: "my-thing" });
    }
  });

  test("cloud-skill 不会被 skill 的分支抢先匹配", () => {
    expect(parseComposerCapabilityToken("[cloud-skill wechat]")).toEqual({
      kind: "cloud-skill",
      name: "wechat",
    });
  });

  test("cloud-mcp 与本地 mcp 使用不同 token", () => {
    expect(parseComposerCapabilityToken("[cloud-mcp GitHub MCP]")).toEqual({
      kind: "cloud-mcp",
      name: "GitHub MCP",
    });
    expect(parseComposerCapabilityToken("[mcp pgsql]")).toEqual({ kind: "mcp", name: "pgsql" });
  });

  test("非 token 片段返回 null", () => {
    expect(parseComposerCapabilityToken("[unknown x]")).toBeNull();
    expect(parseComposerCapabilityToken("skill x")).toBeNull();
  });

  test("展开时按种类与名称替换", () => {
    const text = `A ${composerCapabilityToken("mcp", "vision")} B`;
    expect(replaceComposerCapabilityTokens(text, (kind, name) => `<${kind}:${name}>`))
      .toBe("A <mcp:vision> B");
  });
});

describe("能力指令", () => {
  test("本地技能的发送文案保持历史格式不变", () => {
    expect(buildCapabilityInstruction("skill", "customize-opencode"))
      .toBe("Load [skill customize-opencode] and follow its instructions.");
  });

  test("指令是祈使句而非名词短语，且带 token", () => {
    for (const kind of KINDS) {
      const sentence = fallbackCapabilityPrompt(kind, "vision");
      expect(sentence.startsWith("Load ") || sentence.startsWith("Use ")).toBe(true);
      expect(sentence).toContain(composerCapabilityToken(kind, "vision"));
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  test("MCP 指令点名它的工具前缀，模型才可能真正调用", () => {
    expect(capabilityDefaultDetail("mcp", "vision")).toBe("call its vision_* tools directly");
    expect(fallbackCapabilityPrompt("mcp", "vision"))
      .toBe("Use [mcp vision] for this request (call its vision_* tools directly).");
  });

  test("Cloud MCP 兜底指令只经网关搜索和执行，不虚构本地工具", () => {
    const prompt = fallbackCapabilityPrompt("cloud-mcp", "GitHub MCP");
    expect(prompt).toContain("[cloud-mcp GitHub MCP]");
    expect(prompt).toContain("jugglework-cloud_search_capabilities");
    expect(prompt).toContain("jugglework-cloud_execute_capability");
    expect(prompt).toContain("exact capability name returned by that search");
    expect(prompt).not.toContain("GitHub MCP_*");
  });

  test("MCP 选择按 Connect 远程承载分流", () => {
    const cloud = resolveMcpCapabilitySelection({
      name: "GitHub MCP",
      origin: "jugglework-connect",
      config: { type: "remote" },
      connectCapabilityName: "mcp:mcpconn_123",
    });
    expect(cloud.kind).toBe("cloud-mcp");
    expect(cloud.prompt).toContain("capability hint mcp:mcpconn_123");
    expect(cloud.prompt).toContain("exact capability name returned by that search");
    expect(cloud.prompt).not.toContain("GitHub MCP_*");

    const local = resolveMcpCapabilitySelection({
      name: "pgsql",
      origin: "local",
      config: { type: "remote" },
    });
    expect(local).toEqual({
      kind: "mcp",
      prompt: "Use [mcp pgsql] for this request (call its pgsql_* tools directly).",
    });

    const connectStdio = resolveMcpCapabilitySelection({
      name: "vision",
      origin: "jugglework-connect",
      config: { type: "local" },
    });
    expect(connectStdio.kind).toBe("mcp");
  });

  test("整句指令能被分词切出并解析回原始种类与名称", () => {
    const cases: Array<[ComposerCapabilityKind, string, string | undefined]> = [
      ["skill", "customize-opencode", undefined],
      ["cloud-skill", "wechat-article-writer", "find it with jugglework-cloud_search_capabilities in the Public marketplace, then call jugglework-cloud_execute_capability with the exact capability name wechat"],
      ["extension", "Computer Use", undefined],
      ["mcp", "vision", capabilityDefaultDetail("mcp", "vision")],
      ["cloud-mcp", "GitHub MCP", capabilityDefaultDetail("cloud-mcp", "GitHub MCP")],
    ];
    for (const [kind, name, detail] of cases) {
      const sentence = buildCapabilityInstruction(kind, name, detail);
      const segments = `请帮我 ${sentence} 谢谢`.split(CAPABILITY_INSTRUCTION_RE);
      expect(segments).toContain(sentence);
      expect(parseCapabilityInstruction(sentence)).toEqual({ kind, name });
    }
  });

  test("裸 token 也能被折叠成 tag（草稿未经指令包装时的退路）", () => {
    expect(parseCapabilityInstruction("[extension Computer Use]"))
      .toEqual({ kind: "extension", name: "Computer Use" });
  });

  test("用户自己写的句子不会被误判成能力指令", () => {
    expect(parseCapabilityInstruction("Use the vision server for this request.")).toBeNull();
    expect(CAPABILITY_INSTRUCTION_RE.test("请识别这张图片。")).toBe(false);
  });

  test("紧跟指令后的用户文本不会被正则吞掉", () => {
    const sentence = buildCapabilityInstruction("mcp", "vision", capabilityDefaultDetail("mcp", "vision"));
    const text = `${sentence} 识别这张图里的内容。`;
    const segments = text.split(CAPABILITY_INSTRUCTION_RE).filter(Boolean);
    expect(segments).toEqual([sentence, " 识别这张图里的内容。"]);
  });
});
