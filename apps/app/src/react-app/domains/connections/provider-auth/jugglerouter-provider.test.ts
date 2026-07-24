declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  buildJuggleRouterProviderConfig,
  JUGGLEROUTER_BASE_URL,
} from "./jugglerouter-provider";

describe("buildJuggleRouterProviderConfig", () => {
  test("uses the OpenAI-compatible endpoint and maps catalog capabilities", () => {
    const config = buildJuggleRouterProviderConfig([
      { id: "vision-tools", tags: ["chat", "vision", "tools"] },
      { id: "thinking-model", tags: ["chat", "thinking"] },
      { id: "plain-chat", tags: ["chat"] },
    ]);

    expect(config.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.options).toEqual({ baseURL: JUGGLEROUTER_BASE_URL });
    expect(config.models).toEqual({
      "vision-tools": {
        id: "vision-tools",
        name: "vision-tools",
        attachment: true,
        reasoning: false,
        tool_call: true,
      },
      "thinking-model": {
        id: "thinking-model",
        name: "thinking-model",
        attachment: false,
        reasoning: true,
        tool_call: false,
      },
      "plain-chat": {
        id: "plain-chat",
        name: "plain-chat",
        attachment: false,
        reasoning: false,
        tool_call: false,
      },
    });
  });
});
