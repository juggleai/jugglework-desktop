/**
 * 会话级模型选择（每个会话拥有自己的模型与推理档位）。
 *
 * 背景：模型选择原本只写在全局偏好 `local.prefs.defaultModel` 上，于是在任意
 * 一个会话里切换模型会同时改掉其他所有会话。这里按「工作区 → 会话」维度持久化
 * 覆盖值，全局默认模型退化为「没有单独选过模型的会话」的兜底值。
 *
 * 存储位置：localStorage `jugglework.sessionModels.<workspaceId>`，
 * 结构为 `{ [sessionId]: { model?: "provider/model", variant?: string | null } }`。
 */
import { useSyncExternalStore } from "react";

import { SESSION_MODEL_PREF_KEY } from "../../app/constants";
import type { ModelRef } from "../../app/types";
import { modelEquals } from "../../app/utils";
import {
  parseSessionChoiceOverrides,
  serializeSessionChoiceOverrides,
  sessionModelOverridesKey,
  type SessionChoiceOverride,
} from "./model-config";

/** 单个工作区内 sessionId → 会话模型选择 的映射 */
export type SessionChoiceMap = Record<string, SessionChoiceOverride>;

const EMPTY_CHOICES: SessionChoiceMap = {};

// TIPS: 用模块级缓存 + useSyncExternalStore 而不是组件内 useState，是因为读写
// 都发生在 localStorage 上：缓存保证快照引用稳定（否则每次渲染都会拿到新对象
// 触发无限重渲染），订阅保证任意入口写入后所有消费者立即同步。
const choicesCache = new Map<string, SessionChoiceMap>();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const hasVariant = (choice: SessionChoiceOverride | undefined): boolean =>
  Boolean(choice) && Object.prototype.hasOwnProperty.call(choice, "variant");

/**
 * 读取某个工作区的会话模型选择表
 * @param workspaceId 工作区 id
 * @returns sessionId → 会话模型选择（引用稳定，可直接用于 memo 依赖）
 */
export function readSessionChoices(workspaceId: string): SessionChoiceMap {
  const id = workspaceId.trim();
  if (!id || typeof window === "undefined") return EMPTY_CHOICES;

  const cached = choicesCache.get(id);
  if (cached) return cached;

  let parsed: SessionChoiceMap = EMPTY_CHOICES;
  try {
    parsed = parseSessionChoiceOverrides(
      window.localStorage.getItem(sessionModelOverridesKey(id)),
    );
  } catch {
    parsed = EMPTY_CHOICES;
  }
  choicesCache.set(id, parsed);
  return parsed;
}

function writeSessionChoices(workspaceId: string, next: SessionChoiceMap): void {
  const id = workspaceId.trim();
  if (!id) return;

  choicesCache.set(id, next);
  if (typeof window !== "undefined") {
    try {
      const payload = serializeSessionChoiceOverrides(next);
      if (payload) {
        window.localStorage.setItem(sessionModelOverridesKey(id), payload);
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(id));
      }
    } catch {
      // ignore quota errors
    }
  }
  emitChange();
}

// 另一个窗口改了同一个会话的模型时，丢弃本窗口缓存并重新读取。
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const key = event.key;
    if (!key || !key.startsWith(`${SESSION_MODEL_PREF_KEY}.`)) return;
    choicesCache.delete(key.slice(SESSION_MODEL_PREF_KEY.length + 1));
    emitChange();
  });
}

/**
 * 为某个会话固定模型
 * @param workspaceId 工作区 id
 * @param sessionId 会话 id
 * @param model 该会话要使用的模型
 */
export function setSessionModelChoice(
  workspaceId: string,
  sessionId: string,
  model: ModelRef,
): void {
  const id = sessionId.trim();
  if (!id) return;

  const current = readSessionChoices(workspaceId);
  const existing = current[id];
  // TIPS: 推理档位依附于具体模型，换模型时必须丢弃旧档位，换回同一个模型才保留。
  const keepVariant = Boolean(existing?.model && modelEquals(existing.model, model)) && hasVariant(existing);
  const next: SessionChoiceOverride = keepVariant
    ? { model, variant: existing?.variant ?? null, ...(hasAgentProfile(existing) ? { agentProfile: existing?.agentProfile ?? null } : {}) }
    : { model, ...(hasAgentProfile(existing) ? { agentProfile: existing?.agentProfile ?? null } : {}) };

  writeSessionChoices(workspaceId, { ...current, [id]: next });
}

/**
 * 为某个会话固定推理档位（thinking / reasoning 变体）
 * @param workspaceId 工作区 id
 * @param sessionId 会话 id
 * @param variant 档位值，null 表示该模型的默认档位
 */
export function setSessionVariantChoice(
  workspaceId: string,
  sessionId: string,
  variant: string | null,
): void {
  const id = sessionId.trim();
  if (!id) return;

  const current = readSessionChoices(workspaceId);
  const existing = current[id];
  writeSessionChoices(workspaceId, {
    ...current,
    [id]: {
      ...(existing?.model ? { model: existing.model } : {}),
      variant,
      ...(hasAgentProfile(existing) ? { agentProfile: existing?.agentProfile ?? null } : {}),
    },
  });
}

const hasAgentProfile = (choice: SessionChoiceOverride | undefined): boolean =>
  Boolean(choice) && Object.prototype.hasOwnProperty.call(choice, "agentProfile");

export function setSessionAgentProfileChoice(
  workspaceId: string,
  sessionId: string,
  agentProfile: string | null,
): void {
  const id = sessionId.trim();
  if (!id) return;
  const current = readSessionChoices(workspaceId);
  const existing = current[id];
  writeSessionChoices(workspaceId, {
    ...current,
    [id]: {
      ...(existing?.model ? { model: existing.model } : {}),
      ...(hasVariant(existing) ? { variant: existing?.variant ?? null } : {}),
      agentProfile: agentProfile?.trim() || null,
    },
  });
}

/**
 * 清除某个会话的模型选择，使其回落到全局默认模型
 * @param workspaceId 工作区 id
 * @param sessionId 会话 id
 */
export function clearSessionModelChoice(workspaceId: string, sessionId: string): void {
  const id = sessionId.trim();
  if (!id) return;

  const current = readSessionChoices(workspaceId);
  if (!current[id]) return;

  const next = { ...current };
  delete next[id];
  writeSessionChoices(workspaceId, next);
}

/**
 * 计算某个会话实际生效的模型与推理档位
 * @param input.choices 当前工作区的会话模型选择表
 * @param input.sessionId 会话 id，null 表示还没有选中会话
 * @param input.defaultModel 全局默认模型（设置页配置）
 * @param input.defaultVariant 全局默认推理档位
 * @returns 该会话生效的模型与推理档位
 */
export function resolveSessionModelChoice(input: {
  choices: SessionChoiceMap;
  sessionId: string | null;
  defaultModel: ModelRef | null;
  defaultVariant: string | null;
}): { model: ModelRef | null; variant: string | null } {
  const choice = input.sessionId ? input.choices[input.sessionId] : undefined;
  const model = choice?.model ?? input.defaultModel;

  // TIPS: 档位的兜底顺序 —— 会话显式设置过就用会话的；没设置过时，只有当会话仍在
  // 使用全局默认模型时才继承全局档位，否则回到该模型自己的默认档位（null）。
  if (hasVariant(choice)) {
    return { model, variant: choice?.variant ?? null };
  }
  const usesDefaultModel =
    !choice?.model || Boolean(input.defaultModel && modelEquals(choice.model, input.defaultModel));
  return { model, variant: usesDefaultModel ? input.defaultVariant : null };
}

/**
 * 订阅某个工作区的会话模型选择表
 * @param workspaceId 工作区 id
 * @returns sessionId → 会话模型选择
 */
export function useSessionModelChoices(workspaceId: string): SessionChoiceMap {
  return useSyncExternalStore(
    subscribe,
    () => readSessionChoices(workspaceId),
    () => EMPTY_CHOICES,
  );
}
