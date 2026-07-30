// Provider catalog cache + behavior (reasoning/thinking variant) options for
// the active default model — what the composer renders as its variant pill.
// Extracted verbatim from session-route.tsx; the catalog is also consumed by
// the model picker's lazy option loader until that moves into its own hook.
import { useCallback, useEffect, useMemo, useState } from "react";

import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import type { ModelRef, ProviderListItem } from "@/app/types";
import { t } from "@/i18n";

type ProviderModel = ProviderListItem["models"][string];

export type ProviderCatalog = Record<string, Record<string, ProviderModel>>;

const emptyModelBehaviorOptions: { value: string | null; label: string }[] = [];

export type UseModelBehaviorInput = {
  /** Result of useProviderListQuery().data — refreshed by the route. */
  providerList: { all: ProviderListItem[] } | undefined;
  defaultModel: ModelRef | null;
  modelVariant: string | null;
};

export function useModelBehavior(input: UseModelBehaviorInput) {
  const { providerList, defaultModel, modelVariant } = input;
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog>({});

  // Prefetch the full provider catalog once so `getModelBehaviorSummary` has
  // everything it needs to expose the reasoning/thinking variants the active
  // model supports — without waiting for the model picker to open. Cached
  // as providerID → modelID → ProviderModel.
  useEffect(() => {
    if (!providerList?.all) return;
    const next: ProviderCatalog = {};
    for (const provider of providerList.all) {
      next[provider.id] = { ...(provider.models ?? {}) };
    }
    setProviderCatalog(next);
  }, [providerList]);

  /**
   * 计算任意「模型 + 推理档位」组合的展示信息
   * @param model 模型引用，null 表示尚未选择模型
   * @param variant 推理档位，null 表示该模型的默认档位
   * @returns 档位文案、可选档位列表，以及针对该模型消毒后的档位值
   */
  const describeModel = useCallback((model: ModelRef | null, variant: string | null) => {
    if (!model) {
      return {
        modelVariantLabel: t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: null as string | null,
      };
    }
    const entry = providerCatalog[model.providerID]?.[model.modelID];
    if (!entry) {
      return {
        modelVariantLabel: variant ?? t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: variant,
      };
    }
    const summary = getModelBehaviorSummary(model.providerID, entry, variant);
    return {
      modelVariantLabel: summary.label,
      modelBehaviorOptions: summary.options,
      modelVariantValue: summary.value,
    };
  }, [providerCatalog]);

  // Behavior (reasoning/thinking variant) options for the session's active model.
  const { modelVariantLabel, modelBehaviorOptions, modelVariantValue } = useMemo(
    () => describeModel(defaultModel, modelVariant ?? null),
    [defaultModel, describeModel, modelVariant],
  );

  return { providerCatalog, describeModel, modelVariantLabel, modelBehaviorOptions, modelVariantValue };
}
