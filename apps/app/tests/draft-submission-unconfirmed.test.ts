import { expect, test } from "bun:test";
import { submitSessionDraft } from "../src/react-app/domains/session/sync/draft-submission";
import type { Client } from "../src/app/types";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";

// 仅替换网络层：promptAsync 抛出指定错误，其余走真实提交链路。
async function submitWithError(failure: unknown, sessionId: string) {
  const client = { session: { promptAsync: async () => { throw failure; } } } as unknown as Client;
  const host = { baseUrl: "https://test.invalid", listUserEnvKeys: async () => ({ keys: [] }) } as unknown as JuggleWorkServerClient;
  return submitSessionDraft({
    client, host, workspaceId: "ws", sessionId, runtimeKey: undefined, isCurrent: () => true, endpoint: null, workspaceRoot: "/target",
    draft: { text: "hi", parts: [{ type: "text", text: "hi" }], attachments: [], mode: "prompt" },
    prepare: async () => ({ model: null, variant: null }),
    cloudSubmit: async ({ send }) => { await send(); return { outcome: "sent", bypassed: true }; },
    validateGeneration: () => true,
  } as never);
}

test("unconfirmed submission keeps the fixed prefix and appends the HTTP status", async () => {
  const error = Object.assign(new Error("Bad Gateway"), { status: 502, code: "upstream_failed" });
  const result = submitWithError(error, "unconfirmed-status");
  await expect(result).rejects.toThrow(/^发送结果待确认，请先打开原任务核对，再决定是否重试（HTTP 502 upstream_failed Bad Gateway）$/);
});

test("unconfirmed submission appends the timeout or network cause", async () => {
  const timeout = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" } });
  await expect(submitWithError(timeout, "unconfirmed-timeout")).rejects.toThrow(/发送结果待确认.*fetch failed.*UND_ERR_HEADERS_TIMEOUT.*Headers Timeout Error/);
  await expect(submitWithError("network request timed out", "unconfirmed-string")).rejects.toThrow(/发送结果待确认.*（network request timed out）$/);
});

test("unconfirmed detail is single-line and truncated", async () => {
  const error = Object.assign(new Error(`timeout\n${"x".repeat(500)}`), { status: 504 });
  const message = await submitWithError(error, "unconfirmed-long").catch((caught: Error) => caught.message);
  expect(message).toContain("HTTP 504");
  expect(message).not.toContain("\n");
  expect(message.length).toBeLessThan(220);
});

test("errors that are not unconfirmed keep their original message without the prefix", async () => {
  const error = Object.assign(new Error("Model is not available"), { status: 403 });
  await expect(submitWithError(error, "confirmed-failure")).rejects.toThrow("Model is not available");
});
