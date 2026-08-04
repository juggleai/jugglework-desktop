import { describe, expect, test } from "bun:test";

import {
  composerMcpToken,
  expandComposerMcpTokens,
} from "../src/react-app/domains/session/surface/composer/mcp-token";
import { mcpSlashCommandOptions } from "../src/react-app/domains/session/surface/composer/slash-command";
import type { McpServerEntry } from "../src/app/types";

function connectMcp(name: string): McpServerEntry {
  return {
    id: `jugglework-connect:connection:${name}`,
    name,
    config: { type: "remote", url: `https://work.example/${name}` },
    origin: "jugglework-connect",
  };
}

describe("composer MCP token", () => {
  test("expands a selected MCP back into its full instruction before sending", () => {
    const text = `${composerMcpToken("GitHub")} 查看项目信息`;
    const resolved = expandComposerMcpTokens(text, { GitHub: "Use the GitHub organization MCP through JuggleWork Cloud. Use it to " });

    // The composer shows a short chip; the model still receives the whole instruction.
    expect(resolved).toBe("Use the GitHub organization MCP through JuggleWork Cloud. Use it to  查看项目信息");
  });

  test("keeps names with spaces and punctuation intact", () => {
    const text = composerMcpToken("Acme Jira (prod)");
    expect(expandComposerMcpTokens(text, { "Acme Jira (prod)": "INSTRUCTION" })).toBe("INSTRUCTION");
  });

  test("expands every occurrence, including repeats of the same MCP", () => {
    const text = `${composerMcpToken("GitHub")} 然后 ${composerMcpToken("Jira")} 再 ${composerMcpToken("GitHub")}`;
    expect(expandComposerMcpTokens(text, { GitHub: "G", Jira: "J" })).toBe("G 然后 J 再 G");
  });

  test("falls back to a safe description when the instruction was lost", () => {
    // A draft can outlive its stored instruction (session restore, cleared state).
    expect(expandComposerMcpTokens(composerMcpToken("GitHub"), {})).toBe('the "GitHub" MCP server');
  });

  test("leaves unrelated bracket text untouched", () => {
    const text = "[skill research] [attachment a1] [mcp GitHub]";
    expect(expandComposerMcpTokens(text, { GitHub: "G" })).toBe("[skill research] [attachment a1] G");
  });

  test("projects MCP servers into slash options that carry the entry", () => {
    const options = mcpSlashCommandOptions([connectMcp("GitHub")]);

    expect(options).toHaveLength(1);
    expect(options[0]?.name).toBe("github");
    expect(options[0]?.source).toBe("mcp");
    // Selection needs the entry itself to decide gating (status, origin).
    expect(options[0]?.mcp?.origin).toBe("jugglework-connect");
  });
});
