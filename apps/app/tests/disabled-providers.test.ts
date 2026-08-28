import { describe, expect, test } from "bun:test";

import {
  applyDisabledProviderEntry,
  disabledProviderKey,
  normalizeDisabledProviders,
  sameDisabledProviderList,
} from "../src/react-app/domains/connections/provider-auth/disabled-providers";

describe("normalizeDisabledProviders", () => {
  test("去空白、去空项并去重", () => {
    expect(normalizeDisabledProviders([" openai ", "", "openai", "anthropic"])).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  test("非数组返回空列表", () => {
    expect(normalizeDisabledProviders(undefined)).toEqual([]);
    expect(normalizeDisabledProviders({ openai: true })).toEqual([]);
  });
});

describe("applyDisabledProviderEntry", () => {
  test("加入停用时追加到末尾", () => {
    expect(applyDisabledProviderEntry(["a"], "b", true)).toEqual(["a", "b"]);
  });

  test("移出停用时只影响目标条目", () => {
    expect(applyDisabledProviderEntry(["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
  });

  test("大小写不同也能移出停用", () => {
    expect(applyDisabledProviderEntry(["OpenRouter", "a"], "openrouter", false)).toEqual(["a"]);
  });

  test("重复加入时保留列表中已记录的原始大小写", () => {
    expect(applyDisabledProviderEntry(["OpenRouter"], "openrouter", true)).toEqual(["OpenRouter"]);
  });

  test("不修改入参", () => {
    const list = ["a", "b"];
    applyDisabledProviderEntry(list, "a", false);
    expect(list).toEqual(["a", "b"]);
  });

  test("空 provider ID 返回原列表副本", () => {
    expect(applyDisabledProviderEntry(["a"], "   ", true)).toEqual(["a"]);
  });
});

describe("sameDisabledProviderList", () => {
  test("顺序敏感", () => {
    expect(sameDisabledProviderList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameDisabledProviderList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameDisabledProviderList(["a"], ["a", "b"])).toBe(false);
  });
});

describe("disabledProviderKey", () => {
  test("按小写归一", () => {
    expect(disabledProviderKey("  OpenAI ")).toBe("openai");
  });
});

describe("停用写入基准", () => {
  // 回归：断开 B 时若以合并后的有效配置为基准，会把全局配置声明的 A 一并写入
  // 工作区运行时层，导致用户之后从全局配置移除 A 也不再生效。
  test("以运行时层为基准断开一个 provider 不会带入其他来源的停用项", () => {
    const merged = ["global-only", "runtime-one"];
    const runtimeLayer = ["runtime-one"];
    expect(applyDisabledProviderEntry(runtimeLayer, "runtime-two", true)).toEqual([
      "runtime-one",
      "runtime-two",
    ]);
    expect(merged).toEqual(["global-only", "runtime-one"]);
  });
});
