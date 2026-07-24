import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

import type { OpenworkJuggleRouterModel } from "../../../../app/lib/openwork-server";

export const JUGGLEROUTER_PROVIDER_ID = "jugglerouter";
export const JUGGLEROUTER_PROVIDER_NAME = "JuggleRouter";
export const JUGGLEROUTER_WEBSITE_URL = "https://jugglerouter.com";
export const JUGGLEROUTER_BASE_URL = "https://jugglerouter.com/v1";

export function buildJuggleRouterProviderConfig(
  catalog: OpenworkJuggleRouterModel[],
): ProviderConfig {
  return {
    id: JUGGLEROUTER_PROVIDER_ID,
    name: JUGGLEROUTER_PROVIDER_NAME,
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: JUGGLEROUTER_BASE_URL },
    models: Object.fromEntries(
      catalog.map((model) => {
        const tags = new Set(model.tags);
        return [
          model.id,
          {
            id: model.id,
            name: model.id,
            attachment: tags.has("vision"),
            reasoning: tags.has("reasoning") || tags.has("thinking"),
            tool_call: tags.has("tools"),
          },
        ];
      }),
    ),
  };
}
