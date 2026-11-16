import { afterEach, describe, expect, test } from "bun:test";
import {
  extractSuggestionContext, generatePromptSuggestion, normalizeSuggestion, promptSuggestionsRequestSchema,
  readPromptSuggestionRequest, suggestionPayload, type PromptSuggestionDependencies, type SuggestionMessage,
} from "./session-prompt-suggestions.js";
import { withSignal, type ResolvedTextModel, type TextProtocol } from "./text-model-inference.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input = { turnKey: "u2", model: { providerID: "p", modelID: "m" } };
function timeoutSignal(milliseconds: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("test deadline")), milliseconds);
  return controller.signal;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function user(id = "u2", text = "只分析，不修改，不提交", source: string | undefined = "user"): SuggestionMessage {
  return { info: { id, sessionID: "ses", role: "user", time: { created: Number(id.slice(1)) * 10 } }, parts: [
    { type: "text", text, metadata: source ? { composerTextSource: source } : {} },
  ] };
}
function assistant(parentID = "u2", text = "分析完成"): SuggestionMessage {
  return { info: { id: `a${parentID.slice(1)}`, parentID, sessionID: "ses", role: "assistant", time: { created: Number(parentID.slice(1)) * 10 + 1, completed: 100 }, finish: "stop" },
    parts: [{ type: "text", text }, { type: "reasoning", text: "private reasoning" }, { type: "tool", state: { status: "completed", output: "private output" } }] };
}
function model(protocol: TextProtocol = "openai-completions"): ResolvedTextModel {
  return { protocol, baseURL: "https://models.example/v1", key: "fake-test-secret", modelId: "m", upstreamModelId: "m", headers: {}, provider: {}, model: {} };
}
function upstream(protocol: TextProtocol, text = "请进一步分析这些风险") {
  if (protocol === "openai-completions") return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] };
  if (protocol === "anthropic-messages") return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  return { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] };
}
function fixture(protocol: TextProtocol = "openai-completions") {
  const calls = { pages: [] as Array<string | undefined>, states: 0, models: 0, upstream: 0 };
  let messages = [user(), assistant()];
  let idle = true;
  let selected: ResolvedTextModel | null = model(protocol);
  const dependencies: PromptSuggestionDependencies = {
    readState: async () => { calls.states++; return { session: { id: "ses" }, idle, preferenceRevision: 0 }; },
    readPage: async before => { calls.pages.push(before); return { items: messages, olderCursor: null }; },
    resolveModel: async () => { calls.models++; return selected; },
  };
  globalThis.fetch = (async () => { calls.upstream++; return Response.json(upstream(protocol)); }) as unknown as typeof fetch;
  const run = (signal = new AbortController().signal, requestSignal = signal) => generatePromptSuggestion(input, dependencies, signal, requestSignal);
  return { calls, dependencies, run, messages: (next: SuggestionMessage[]) => { messages = next; }, idle: (next: boolean) => { idle = next; }, model: (next: ResolvedTextModel | null) => { selected = next; } };
}

describe("bounded suggestion context", () => {
  test("extracts complete user-sourced turns only, current first in budget, no reasoning/tools/expansions", () => {
    const latest = user();
    latest.parts.push({ type: "text", text: "capability instructions", metadata: { composerTextSource: "capability" } },
      { type: "text", text: "app expansion", metadata: { composerTextSource: "app" } },
      { type: "text", text: "attachment contents", metadata: { composerTextSource: "attachment" } },
      { type: "text", text: "synthetic text", synthetic: true }, { type: "file", url: "data:private" });
    expect(extractSuggestionContext([user("u1", "old"), assistant("u1", "old response"), latest, assistant()], {}, "u2")).toEqual([
      { user: "old", assistant: "old response" }, { user: "只分析，不修改，不提交", assistant: "分析完成" },
    ]);
    expect(extractSuggestionContext([user("u1", "x".repeat(20_000)), assistant("u1"), latest, assistant()], {}, "u2")).toEqual([
      { user: "只分析，不修改，不提交", assistant: "分析完成" },
    ]);
    const many = Array.from({ length: 5 }, (_, index) => [user(`u${index + 1}`), assistant(`u${index + 1}`)]).flat();
    expect(extractSuggestionContext(many, {}, "u5")).toHaveLength(3);
  });

  test("unknown or bound current text skips; older unusable whole turns omitted", () => {
    for (const metadata of [{}, { officeSelectionGroup: "private" }, { cloudDocSourceText: true }, { officeSelections: [] }]) {
      const current = user();
      current.parts.push({ type: "text", text: "hidden limitation", metadata });
      expect(extractSuggestionContext([current, assistant()], {}, "u2")).toBeNull();
      const previous = user("u1"); previous.parts.push({ type: "text", text: "hidden", metadata });
      expect(extractSuggestionContext([previous, assistant("u1"), user(), assistant()], {}, "u2")).toHaveLength(1);
    }
    const legacy = user(); legacy.parts[0].metadata = {};
    expect(extractSuggestionContext([legacy, assistant()], {}, "u2")).toBeNull();
    expect(extractSuggestionContext([user("u2", "only expansion", "capability"), assistant()], {}, "u2")).toBeNull();
    const compacting = user(); compacting.parts.push({ type: "compaction" });
    expect(extractSuggestionContext([compacting, assistant()], {}, "u2")).toBeNull();
  });

  test("explicit latest success, exact parent and revert visibility are required", () => {
    for (const patch of [{ summary: true }, { error: { name: "MessageAbortedError" } }, { finish: "length" }, { finish: "tool-calls" }, { finish: undefined }, { time: { created: 21 } }, { parentID: "u1" }]) {
      const final = assistant(); Object.assign(final.info, patch);
      expect(extractSuggestionContext([user(), final], {}, "u2")).toBeNull();
    }
    expect(extractSuggestionContext([user(), assistant(), user("u3")], {}, "u2")).toBeNull();
    expect(extractSuggestionContext([user(), assistant(), { info: { ...assistant().info, id: "a3", time: { created: 25 }, summary: true }, parts: [] }], {}, "u2")).toBeNull();
    expect(extractSuggestionContext([user(), assistant()], { revert: { messageID: "u2" } }, "u2")).toBeNull();
    expect(extractSuggestionContext([user(), assistant()], { revert: { messageID: "outside-window" } }, "u2")).toBeNull();
    expect(extractSuggestionContext([user(), assistant(), user("u3")], { revert: { messageID: "u3" } }, "u2")).toHaveLength(1);
    expect(extractSuggestionContext([user("u2", "x".repeat(19_999)), assistant("u2", "y")], {}, "u2")).toHaveLength(1);
    expect(extractSuggestionContext([user("u2", "x".repeat(20_000)), assistant("u2", "y")], {}, "u2")).toBeNull();
  });
});

describe("single-model generation", () => {
  for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    test(`${protocol}: one fixed non-streaming no-tool request with 512 token budget`, async () => {
      const f = fixture(protocol);
      const received: { url: string; init: RequestInit }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => { received.push({ url, init }); return Response.json(upstream(protocol)); }) as typeof fetch;
      expect(await f.run()).toEqual({ turnKey: "u2", suggestion: "请进一步分析这些风险" });
      expect(received).toHaveLength(1);
      const payload = JSON.parse(String(received[0].init.body));
      expect(payload.model).toBe("m"); expect(payload.stream).toBe(false); expect(payload.tools).toBeUndefined();
      expect(payload.max_tokens ?? payload.max_output_tokens).toBe(512);
      expect(JSON.stringify(payload)).toContain("analysis-only"); expect(JSON.stringify(payload)).toContain("只分析");
      expect(JSON.stringify(payload)).not.toContain("private reasoning"); expect(JSON.stringify(payload)).not.toContain("private output");
      const headers = new Headers(received[0].init.headers);
      if (protocol === "anthropic-messages") {
        expect(headers.get("x-api-key")).toBe("fake-test-secret");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
      } else expect(headers.get("authorization")).toBe("Bearer fake-test-secret");
    });
  }

  test("at most two 60-message pages per validation, never scans a third page", async () => {
    const f = fixture();
    f.dependencies.readPage = async before => { f.calls.pages.push(before); return { items: before ? [user()] : [assistant()], olderCursor: "older" }; };
    expect((await f.run()).suggestion).not.toBeNull();
    expect(f.calls.pages).toEqual([undefined, "older", undefined, "older"]);
    f.dependencies.readPage = async before => { f.calls.pages.push(before); return { items: [assistant()], olderCursor: "older" }; };
    f.calls.pages.length = 0;
    expect((await f.run()).suggestion).toBeNull(); expect(f.calls.pages).toHaveLength(2);
  });

  test("complete current-page context skips older history in both validations", async () => {
    const f = fixture();
    f.dependencies.readPage = async before => {
      f.calls.pages.push(before);
      return { items: [user(), assistant()], olderCursor: "older" };
    };
    expect((await f.run()).suggestion).not.toBeNull();
    expect(f.calls.pages).toEqual([undefined, undefined]);
  });

  test("older history cannot repair rejected sources or terminal states", async () => {
    for (const items of [
      [user("u2", "untrusted", "unknown"), assistant()],
      [user(), { ...assistant(), info: { ...assistant().info, finish: "tool-calls" } }],
      [user("u2", "x".repeat(20_000)), assistant()],
      [user(), assistant(), user("u3")],
    ]) {
      const f = fixture();
      f.dependencies.readPage = async before => { f.calls.pages.push(before); return { items, olderCursor: "older" }; };
      expect((await f.run()).reason).toBe("ineligible_turn");
      expect(f.calls.pages).toEqual([undefined]); expect(f.calls.upstream).toBe(0);
    }
  });

  test("missing revert boundary can be recovered within the second page", async () => {
    const f = fixture();
    f.dependencies.readState = async () => ({ session: { revert: { messageID: "u3" } }, idle: true, preferenceRevision: 0 });
    f.dependencies.readPage = async before => {
      f.calls.pages.push(before);
      return { items: before ? [user(), assistant(), user("u3")] : [assistant("u3")], olderCursor: "older" };
    };
    expect((await f.run()).suggestion).not.toBeNull();
    expect(f.calls.pages).toEqual([undefined, "older", undefined, "older"]);
  });

  test("state and first page overlap; model overlaps bounded history only after state qualifies, including revalidation", async () => {
    const f = fixture();
    const gates = Array.from({ length: 2 }, () => ({ stateStarted: deferred(), state: deferred(), pageStarted: deferred(),
      page: deferred(), modelStarted: deferred(), model: deferred(), olderStarted: deferred(), older: deferred() }));
    let stateReads = 0, pageReads = 0, modelReads = 0, olderReads = 0;
    f.dependencies.readState = async () => {
      const gate = stateReads === 0 ? gates[0] : stateReads === 2 ? gates[1] : null;
      stateReads++;
      if (gate) { gate.stateStarted.resolve(); await gate.state.promise; }
      return { session: { id: "ses" }, idle: true, preferenceRevision: 0 };
    };
    f.dependencies.readPage = async before => {
      if (before) {
        const gate = gates[olderReads++]; gate.olderStarted.resolve(); await gate.older.promise;
        return { items: [user()], olderCursor: "third" };
      }
      const gate = gates[pageReads++]; gate.pageStarted.resolve(); await gate.page.promise;
      return { items: [assistant()], olderCursor: "older" };
    };
    f.dependencies.resolveModel = async () => {
      const gate = gates[modelReads++]; gate.modelStarted.resolve(); await gate.model.promise; return model();
    };
    const pending = f.run();
    for (const gate of gates) {
      await Promise.all([gate.stateStarted.promise, gate.pageStarted.promise]);
      expect(modelReads).toBe(gate === gates[0] ? 0 : 1);
      gate.state.resolve();
      // The first page is still held: model resolution must not wait for it.
      await gate.modelStarted.promise;
      gate.page.resolve();
      await gate.olderStarted.promise;
      gate.model.resolve();
      if (gate === gates[0]) expect(f.calls.upstream).toBe(0);
      gate.older.resolve();
    }
    expect((await pending).suggestion).not.toBeNull();
    expect(f.calls.upstream).toBe(1); expect(pageReads + olderReads).toBe(4);
  });

  test("rejected or failed state never reads credentials or infers even with a ready page", async () => {
    for (const fail of [false, true]) {
      const f = fixture(); const gate = deferred(); const started = deferred();
      f.dependencies.readState = async () => {
        started.resolve(); await gate.promise;
        if (fail) throw new Error("state unavailable");
        return { session: {}, idle: false, preferenceRevision: 0 };
      };
      const pending = f.run(); await started.promise;
      expect(f.calls.models).toBe(0); gate.resolve();
      if (fail) await expect(pending).rejects.toThrow("state unavailable");
      else expect((await pending).reason).toBe("ineligible_turn");
      expect(f.calls.models).toBe(0); expect(f.calls.upstream).toBe(0);
    }
  });

  test("state is rechecked after model resolution before inference and before returning", async () => {
    for (const atModelRead of [1, 2]) {
      const f = fixture();
      f.dependencies.resolveModel = async () => { if (++f.calls.models === atModelRead) f.idle(false); return model(); };
      expect((await f.run()).reason).toBe("ineligible_turn");
      expect(f.calls.upstream).toBe(atModelRead - 1);
    }
  });

  test("new turn, host busy, changed final, changed preference or model invalidates the result", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.messages([user(), assistant(), user("u3")]),
      (f: ReturnType<typeof fixture>) => f.idle(false),
      (f: ReturnType<typeof fixture>) => f.messages([user(), assistant("u2", "changed response")]),
      (f: ReturnType<typeof fixture>) => f.messages([user("u2", "changed source", "unknown"), assistant()]),
      (f: ReturnType<typeof fixture>) => { const last = assistant(); last.info.finish = "length"; f.messages([user(), last]); },
      (f: ReturnType<typeof fixture>) => { f.dependencies.readState = async () => ({ session: { id: "ses" }, idle: true, preferenceRevision: 1 }); },
      (f: ReturnType<typeof fixture>) => { f.dependencies.readState = async () => ({ session: { id: "ses", revert: { messageID: "u2" } }, idle: true, preferenceRevision: 0 }); },
      (f: ReturnType<typeof fixture>) => f.model(null),
      (f: ReturnType<typeof fixture>) => f.model({ ...model(), key: "rotated-test-key" }),
    ]) {
      const f = fixture();
      globalThis.fetch = (async () => { f.calls.upstream++; change(f); return Response.json(upstream("openai-completions")); }) as unknown as typeof fetch;
      expect((await f.run()).suggestion).toBeNull(); expect(f.calls.upstream).toBe(1);
    }
  });

  test("missing model/context and busy sessions never infer", async () => {
    const f = fixture(); f.model(null); expect((await f.run()).reason).toBe("model_unavailable");
    f.idle(false); expect((await f.run()).reason).toBe("ineligible_turn");
    expect(f.calls.upstream).toBe(0);
  });

  test("slow non-cancellable history stops waiting; parallel model resolution cannot start inference", async () => {
    const f = fixture(); let release!: () => void;
    f.dependencies.readPage = async () => { await new Promise<void>(resolve => { release = resolve; }); return { items: [user(), assistant()], olderCursor: null }; };
    await expect(f.run(timeoutSignal(25))).rejects.toBeDefined();
    release(); await Promise.resolve();
    expect(f.calls.models).toBe(1); expect(f.calls.upstream).toBe(0);
  });

  test("slow model resolution stops waiting and cannot start inference after deadline", async () => {
    const f = fixture(); let release!: (value: ResolvedTextModel) => void;
    f.dependencies.resolveModel = () => new Promise(resolve => { release = resolve; });
    await expect(f.run(timeoutSignal(20))).rejects.toBeDefined();
    release(model()); await Promise.resolve();
    expect(f.calls.upstream).toBe(0);
  });

  test("history and slow body share one deadline; cancellation cancels body; no retry", async () => {
    const f = fixture(); let cancelled = 0;
    f.dependencies.readPage = async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { items: [user(), assistant()], olderCursor: null }; };
    let bodySignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      f.calls.upstream++; bodySignal = init.signal!;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const started = Date.now();
    await expect(f.run(timeoutSignal(55))).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(150); expect(bodySignal?.aborted).toBe(true); expect(cancelled).toBe(1); expect(f.calls.upstream).toBe(1);
    const controller = new AbortController(); controller.abort();
    await expect(f.run(controller.signal)).rejects.toBeDefined(); expect(f.calls.upstream).toBe(1);
  });

  test("transport and upstream failures are redacted with no retry", async () => {
    const f = fixture();
    globalThis.fetch = (async () => { f.calls.upstream++; throw new Error("private transcript fake-test-secret"); }) as unknown as typeof fetch;
    const failure = await f.run().catch(error => error);
    expect(failure).toMatchObject({ code: "model_transport_failed" }); expect(JSON.stringify(failure)).not.toContain("fake-test-secret"); expect(f.calls.upstream).toBe(1);
    globalThis.fetch = (async () => Response.json({ private: "fake-test-secret" }, { status: 429 })) as unknown as typeof fetch;
    expect(await f.run().catch(error => error)).toMatchObject({ status: 429, code: "model_request_failed" });
  });

  test("in-flight upstream cancellation propagates, no retry or background continuation", async () => {
    const f = fixture(); const controller = new AbortController();
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    let transportSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      f.calls.upstream++; transportSignal = init.signal!; started();
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }) as typeof fetch;
    const pending = f.run(controller.signal); await dispatched; controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499, code: "request_cancelled" });
    expect(transportSignal?.aborted).toBe(true); expect(f.calls.upstream).toBe(1);
  });

  test("invalid JSON, excessive response body and malformed content return empty without repair", async () => {
    for (const body of ["{bad-json", "x".repeat(65537), JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: [] } }] })]) {
      const f = fixture();
      globalThis.fetch = (async () => { f.calls.upstream++; return new Response(body, { headers: { "Content-Type": "application/json" } }); }) as unknown as typeof fetch;
      expect((await f.run()).reason).toBe("no_suggestion"); expect(f.calls.upstream).toBe(1);
    }
  });
});

test("strict request boundary and bounded body", async () => {
  for (const payload of [{ ...input, system: "x" }, { ...input, history: [] }, { ...input, model: { ...input.model, apiKey: "x" } }, { ...input, turnKey: " u2" }])
    expect(promptSuggestionsRequestSchema.safeParse(payload).success).toBe(false);
  await expect(readPromptSuggestionRequest(new Request("https://test", { method: "POST", body: "x".repeat(4097) }), new AbortController().signal)).rejects.toMatchObject({ status: 413 });
  const signal = timeoutSignal(10);
  await expect(withSignal(signal, () => new Promise(() => {}))).rejects.toBeDefined();
});

test("rejects truncated, malformed, multiline, oversized, reasoning-only and execution output without repair", () => {
  for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    for (const text of ["", "x".repeat(241), "a\nb", "a\u2028b", "```run```", "<tool_call>run</tool_call>", '{"command":"run"}', "1. do this", "/run", "\"quoted\""]) expect(normalizeSuggestion(protocol, upstream(protocol, text))).toBeNull();
    expect(normalizeSuggestion(protocol, upstream(protocol, "😀".repeat(120)))).toHaveLength(240);
    expect(normalizeSuggestion(protocol, upstream(protocol, "😀".repeat(121)))).toBeNull();
    expect(suggestionPayload(protocol, [])).not.toHaveProperty("tools");
  }
  expect(normalizeSuggestion("openai-completions", { choices: [{ finish_reason: "length", message: { content: "partial" } }] })).toBeNull();
  expect(normalizeSuggestion("openai-completions", { choices: [{ finish_reason: "stop", message: { role: "assistant", reasoning_content: "reason" } }] })).toBeNull();
  expect(normalizeSuggestion("anthropic-messages", { stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] })).toBeNull();
  expect(normalizeSuggestion("anthropic-messages", { stop_reason: "end_turn", content: [null] })).toBeNull();
  expect(normalizeSuggestion("openai-responses", { status: "incomplete", output: [] })).toBeNull();
  expect(normalizeSuggestion("openai-responses", { status: "completed", output: [{ type: "reasoning", summary: [] }] })).toBeNull();
});

test("bounded reasoning responses use only final visible text, never reasoning as a fallback", () => {
  const text = "请进一步分析这些风险";
  expect(normalizeSuggestion("openai-completions", { choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: text, reasoning_content: "private reasoning",
  } }] })).toBe(text);
  expect(normalizeSuggestion("openai-responses", { status: "completed", output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "private reasoning" }] },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
  ] })).toBe(text);
  for (const id of ["gpt-6.1-sol", "gpt-5.1", "o3"]) {
    expect(suggestionPayload("openai-completions", [], id)).toMatchObject({ max_completion_tokens: 512 });
    expect(suggestionPayload("openai-completions", [], id)).not.toHaveProperty("max_tokens");
  }
  expect(suggestionPayload("anthropic-messages", [], "claude-sonnet-4-5")).toMatchObject({ max_tokens: 512, thinking: { type: "disabled" } });
});
