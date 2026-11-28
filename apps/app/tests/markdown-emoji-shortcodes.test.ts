import { describe, expect, test } from "bun:test";

import {
  createEmojiAliases,
  isEmojiShortcode,
  isStandaloneShortcode,
  renderMarkdownHtml,
} from "../src/components/markdown/markdown-primitive";

const text = (markdown: string) => renderMarkdownHtml(markdown).replace(/<[^>]+>/g, "").trim();

describe("emoji shortcodes in markdown", () => {
  test("times, ratios and colon-separated values are left as written", () => {
    for (const value of [
      "14:02 的那次运行",
      "14:1:02 的那次运行",
      "14:01:02 的那次运行",
      "耗时 3:14:02 完成",
      "比例 1:2:3 和 10:30:45",
      "[12:02:07]",
      "格式 hh:mm:ss，例如 09:12:30",
      "http://localhost:3000:8080",
      "ts=2026-11-28T14:02:00",
    ]) {
      expect({ value, rendered: text(value) }).toEqual({ value, rendered: value });
    }
  });

  test("a word between two colons stays when it touches English letters or digits", () => {
    for (const value of ["字段 name:time:value", "关键:key:字段", "key:error:x", "a:b:c 以及 key:value:other"]) {
      expect({ value, rendered: text(value) }).toEqual({ value, rendered: value });
    }
  });

  test("real shortcodes still become emoji, including next to Chinese text", () => {
    expect(text(":smile: :+1: :tada: :rocket: :fire: :warning: :100: :zap: :sparkles: :memo:")).toBe("😀 👍 🎉 🚀 🔥 ⚠️ 💯 ⚡ ✨ 📝");
    expect(text("完成了:tada:很好")).toBe("完成了🎉很好");
    expect(text("好 :smile: 很好")).toBe("好 😀 很好");
    expect(text("(:fire:)")).toBe("(🔥)");
    expect(text("**成功**:rocket:")).toBe("成功🚀");
  });

  test("unknown names, empty codes and code spans or blocks are not converted", () => {
    expect(text(":not_a_code: 与 :: 空")).toBe(":not_a_code: 与 :: 空");
    expect(text("`:smile:` 在代码里")).toBe(":smile: 在代码里");
    expect(renderMarkdownHtml("```\n:smile:\n```")).toContain(":smile:");
    expect(renderMarkdownHtml("```\n:smile:\n```")).not.toContain("😀");
  });

  test("an emoji's own name wins over another emoji's search keyword", () => {
    const aliases = createEmojiAliases();
    expect(aliases.fire).toBe("🔥");
    expect(aliases.rocket).toBe("🚀");
    expect(aliases.sparkles).toBe("✨");
  });

  test("the alias table has no numbers, short words or non-shortcode names", () => {
    const aliases = createEmojiAliases();
    for (const name of Object.keys(aliases)) {
      expect(isEmojiShortcode(name)).toBe(true);
      if (name === "100") continue;
      expect(/^[0-9]+$/.test(name)).toBe(false);
    }
    for (const name of ["02", "12", "0", "mm", "ss", "hh", "cn", ":)", "straight face", "^^"]) expect(aliases[name]).toBeUndefined();
    expect(aliases["100"]).toBe("💯");
    expect(aliases["+1"]).toBe("👍");
  });

  test("standalone check looks only at ASCII letters and digits next to the code", () => {
    expect(isStandaloneShortcode("", "")).toBe(true);
    expect(isStandaloneShortcode(" ", " ")).toBe(true);
    expect(isStandaloneShortcode("好", "好")).toBe(true);
    expect(isStandaloneShortcode("(", ")")).toBe(true);
    expect(isStandaloneShortcode("a", " ")).toBe(false);
    expect(isStandaloneShortcode(" ", "9")).toBe(false);
    expect(isStandaloneShortcode("2", "x")).toBe(false);
  });
});
