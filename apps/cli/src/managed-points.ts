import { isManagedJWorkRouter, type CloudProvider } from "@jugglework/cloud-provider";

export function modelFitsAvailablePoints(provider: CloudProvider, availablePoints: number | null): boolean {
  return !isManagedJWorkRouter(provider) ||
    (availablePoints !== null && availablePoints > 0);
}
