import { describe, expect, test } from "bun:test";

import type { Client } from "../src/app/types";
import { compactSession, isCompactSessionCommand } from "../src/app/lib/opencode-session";

const model = { providerID: "test-provider", modelID: "test-model" };

describe("isCompactSessionCommand", () => {
  test("recognizes compact case-insensitively without matching template commands", () => {
    expect(isCompactSessionCommand({ name: " Compact ", arguments: "" })).toBe(true);
    expect(isCompactSessionCommand({ name: "review", arguments: "compact" })).toBe(false);
    expect(isCompactSessionCommand(undefined)).toBe(false);
  });

  test("rejects unsupported compact arguments", () => {
    expect(() =>
      isCompactSessionCommand({ name: "compact", arguments: "--force" }),
    ).toThrow("/compact does not accept arguments.");
  });
});

describe("compactSession", () => {
  test("uses the native summarize API instead of treating compact as a template command", async () => {
    const summarizeCalls: unknown[] = [];
    const commandCalls: unknown[] = [];
    const client = {
      session: {
        summarize: async (input: unknown) => {
          summarizeCalls.push(input);
          return { data: true };
        },
        command: async (input: unknown) => {
          commandCalls.push(input);
          return { data: true };
        },
      },
    } as unknown as Client;

    await compactSession(client, "session-1", model, {
      directory: "/workspace",
      variant: "high",
    });

    expect(summarizeCalls).toEqual([
      {
        sessionID: "session-1",
        directory: "/workspace",
        providerID: "test-provider",
        modelID: "test-model",
      },
    ]);
    expect(commandCalls).toEqual([]);
  });

  test("passes model, directory, and variant to the legacy fallback", async () => {
    const commandCalls: unknown[] = [];
    const client = {
      session: {
        command: async (input: unknown) => {
          commandCalls.push(input);
          return { data: true };
        },
      },
    } as unknown as Client;

    await compactSession(client, "session-2", model, {
      directory: "/workspace",
      variant: "medium",
    });

    expect(commandCalls).toEqual([
      {
        sessionID: "session-2",
        command: "compact",
        arguments: "",
        model: "test-provider/test-model",
        directory: "/workspace",
        variant: "medium",
      },
    ]);
  });

  test("surfaces errors returned by the summarize API", async () => {
    const client = {
      session: {
        summarize: async () => ({ error: { message: "summarize failed" } }),
      },
    } as unknown as Client;

    expect(compactSession(client, "session-3", model)).rejects.toThrow();
  });
});
