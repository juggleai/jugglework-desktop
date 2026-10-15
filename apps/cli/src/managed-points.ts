import type { CloudProvider } from "@jugglework/cloud-provider";

export function modelFitsAvailablePoints(provider: CloudProvider, availablePoints: number | null): boolean {
  return provider.source?.trim().toLowerCase() !== "juggle_router" ||
    (availablePoints !== null && availablePoints > 0);
}
