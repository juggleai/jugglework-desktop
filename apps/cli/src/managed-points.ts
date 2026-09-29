import type { CloudProvider, CloudProviderModel } from "@jugglework/cloud-provider";

type Decimal = { digits: bigint; scale: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return BigInt(value);
}

function decimal(value: unknown): Decimal | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { digits: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function compareDecimal(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const l = left.digits * 10n ** BigInt(scale - left.scale);
  const r = right.digits * 10n ** BigInt(scale - right.scale);
  return l < r ? -1 : l > r ? 1 : 0;
}

function maximumRate(cost: Record<string, unknown>, keys: string[]): Decimal | null {
  let maximum: Decimal | null = null;
  for (const key of keys) {
    const parsed = decimal(cost[key]);
    if (parsed && (!maximum || compareDecimal(parsed, maximum) > 0)) maximum = parsed;
  }
  return maximum;
}

/** Mirrors the gateway's conservative full-context managed-model reservation. */
export function managedModelReservationPoints(provider: CloudProvider, model: CloudProviderModel): number | null {
  if (provider.source?.trim().toLowerCase() !== "juggle_router") return null;
  const config = record(model.config);
  const limit = record(config?.limit);
  const metadata = record(config?.cost_metadata);
  const sourceCost = record(metadata?.source_cost);
  if (!limit || !metadata || !sourceCost || String(metadata.source_currency).toUpperCase() !== "CNY") return null;
  const context = positiveInteger(limit.context);
  const output = positiveInteger(limit.output);
  const inputRate = maximumRate(sourceCost, ["input", "cache_read", "cache_write"]);
  const outputRate = maximumRate(sourceCost, ["output", "reasoning"]);
  if (!context || !output || !inputRate || !outputRate) return null;

  const scale = Math.max(inputRate.scale, outputRate.scale);
  const scaledInput = inputRate.digits * 10n ** BigInt(scale - inputRate.scale);
  const scaledOutput = outputRate.digits * 10n ** BigInt(scale - outputRate.scale);
  const numerator = (context * scaledInput + output * scaledOutput) * 100n;
  const denominator = 1_000_000n * 10n ** BigInt(scale);
  const points = (numerator + denominator - 1n) / denominator;
  return points <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(points) : null;
}

export function modelReservationPoints(providers: CloudProvider[], modelId: string): number | null {
  const separator = modelId.indexOf("/");
  if (separator < 1) return null;
  const provider = providers.find((item) => item.id === modelId.slice(0, separator));
  const model = provider?.models.find((item) => item.id === modelId.slice(separator + 1));
  return provider && model ? managedModelReservationPoints(provider, model) : null;
}

export function modelFitsAvailablePoints(provider: CloudProvider, model: CloudProviderModel, availablePoints: number | null): boolean {
  const required = managedModelReservationPoints(provider, model);
  return availablePoints === null || required === null || required <= availablePoints;
}
