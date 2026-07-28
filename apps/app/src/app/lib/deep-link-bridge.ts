export const deepLinkBridgeEvent = "jugglework:deep-link";
export const nativeDeepLinkEvent = "jugglework:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __JUGGLEWORK__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const trimmed = url.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__JUGGLEWORK__ ??= {};
  const pending = target.__JUGGLEWORK__.deepLinks ?? [];
  target.__JUGGLEWORK__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__JUGGLEWORK__?.deepLinks ?? [];
  if (target.__JUGGLEWORK__) {
    target.__JUGGLEWORK__.deepLinks = [];
  }
  return [...pending];
}
