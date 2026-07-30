import { beforeEach, describe, expect, test } from "bun:test";

// Minimal window/localStorage stub so the session model store runs under bun.
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: localStorageStub,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  configurable: true,
});

const {
  clearSessionModelChoice,
  readSessionChoices,
  resolveSessionModelChoice,
  setSessionModelChoice,
  setSessionVariantChoice,
} = await import("../src/react-app/kernel/session-model-store");

const DEFAULT_MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4" };
const OTHER_MODEL = { providerID: "openai", modelID: "gpt-5" };

let workspaceSeq = 0;
let workspaceId = "";

function resolve(sessionId: string | null, defaultVariant: string | null = null) {
  return resolveSessionModelChoice({
    choices: readSessionChoices(workspaceId),
    sessionId,
    defaultModel: DEFAULT_MODEL,
    defaultVariant,
  });
}

describe("session model store", () => {
  beforeEach(() => {
    storage.clear();
    // 每个用例换一个工作区 id，避开模块级缓存，等价于全新的工作区。
    workspaceSeq += 1;
    workspaceId = `ws-${workspaceSeq}`;
  });

  test("每个会话保存自己的模型，切换互不影响", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);

    expect(resolve("session-a").model).toEqual(OTHER_MODEL);
    // 没有单独选过模型的会话仍然用全局默认模型。
    expect(resolve("session-b").model).toEqual(DEFAULT_MODEL);
  });

  test("没有选中会话时回落到全局默认模型", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);
    expect(resolve(null).model).toEqual(DEFAULT_MODEL);
  });

  test("换模型会丢弃旧的推理档位，换回同一个模型则保留", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);
    setSessionVariantChoice(workspaceId, "session-a", "high");
    expect(resolve("session-a").variant).toBe("high");

    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);
    expect(resolve("session-a").variant).toBe("high");

    setSessionModelChoice(workspaceId, "session-a", DEFAULT_MODEL);
    expect(resolve("session-a").variant).toBeNull();
  });

  test("会话切到别的模型后不继承全局推理档位", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);

    expect(resolve("session-a", "high").variant).toBeNull();
    // 仍在用全局默认模型的会话继续继承全局档位。
    expect(resolve("session-b", "high").variant).toBe("high");
  });

  test("清除会话选择后回落到全局默认模型", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);
    clearSessionModelChoice(workspaceId, "session-a");

    expect(resolve("session-a").model).toEqual(DEFAULT_MODEL);
    expect(storage.get(`jugglework.sessionModels.${workspaceId}`)).toBeUndefined();
  });

  test("选择持久化到按工作区隔离的 localStorage", () => {
    setSessionModelChoice(workspaceId, "session-a", OTHER_MODEL);
    setSessionVariantChoice(workspaceId, "session-a", "high");

    const raw = storage.get(`jugglework.sessionModels.${workspaceId}`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      "session-a": { model: "openai/gpt-5", variant: "high" },
    });
  });
});
