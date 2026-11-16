import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { juggleworkConfirmationGatePluginPath } from "../jugglework-extensions-plugin-path.js";
import { buildJuggleWorkRuntimeConfigObject } from "../jugglework-runtime-config.js";
import { JuggleWorkConfirmationGate } from "./jugglework-confirmation-gate.js";
import { declaresBlockingConfirmation } from "./jugglework-confirmation-gate-policy.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function textInput(sessionID = "session-a") {
  return { sessionID, messageID: "message-a", partID: "part-a" };
}

function toolInput(tool: string, sessionID = "session-a") {
  return { tool, sessionID, callID: `call-${tool}` };
}

describe("JuggleWork confirmation gate plugin", () => {
  test("recognizes explicit deferred execution without matching quoted or code examples", () => {
    expect(declaresBlockingConfirmation("你确认后，我会开始实现。")).toBe(true);
    expect(declaresBlockingConfirmation("No answer came back to my questions, so I'm going ahead with the defaults.")).toBe(true);
    expect(declaresBlockingConfirmation("Once you confirm, I'll implement the change.")).toBe(true);
    expect(declaresBlockingConfirmation("已完成实现，请确认效果。")).toBe(false);
    expect(declaresBlockingConfirmation("> 你确认后，我会开始实现。")).toBe(false);
    expect(declaresBlockingConfirmation("```md\n你确认后，我会开始实现。\n```")).toBe(false);
  });

  test("blocks non-question tools after a declared confirmation and resumes after a reply", async () => {
    const plugin = await JuggleWorkConfirmationGate();
    await plugin["experimental.text.complete"](
      textInput(),
      { text: "这里有两个范围需要你确认。你确认后，我会开始修改代码。" },
    );

    await expect(plugin["tool.execute.before"](toolInput("bash")))
      .rejects.toThrow("jugglework_user_confirmation_required");
    await expect(plugin["tool.execute.before"](toolInput("question"))).resolves.toBeUndefined();
    await expect(plugin["tool.execute.before"](toolInput("edit")))
      .rejects.toThrow("jugglework_user_confirmation_required");

    await plugin.event({
      event: { type: "question.replied", properties: { sessionID: "session-a", requestID: "question-a" } },
    });
    await expect(plugin["tool.execute.before"](toolInput("bash"))).resolves.toBeUndefined();
  });

  test("keeps rejected questions and synthetic continuations blocked, then accepts a genuine user turn", async () => {
    const plugin = await JuggleWorkConfirmationGate();
    await plugin["experimental.text.complete"](textInput(), { text: "你确认后，我会继续执行。" });

    await plugin.event({
      event: { type: "question.rejected", properties: { sessionID: "session-a", requestID: "question-a" } },
    });
    await expect(plugin["tool.execute.before"](toolInput("bash")))
      .rejects.toThrow("jugglework_user_confirmation_required");

    await plugin["chat.message"](
      { sessionID: "session-a" },
      { parts: [{ synthetic: true }] },
    );
    await expect(plugin["tool.execute.before"](toolInput("bash")))
      .rejects.toThrow("jugglework_user_confirmation_required");

    await plugin["chat.message"](
      { sessionID: "session-a" },
      { parts: [{ synthetic: false }] },
    );
    await expect(plugin["tool.execute.before"](toolInput("bash"))).resolves.toBeUndefined();
  });

  test("does not leak blocking state across sessions", async () => {
    const plugin = await JuggleWorkConfirmationGate();
    await plugin["experimental.text.complete"](textInput("session-a"), { text: "你确认后，我会开始实现。" });

    await expect(plugin["tool.execute.before"](toolInput("bash", "session-b"))).resolves.toBeUndefined();
  });

  test("is registered in runtime config and bundled by the build script", async () => {
    const runtime = await buildJuggleWorkRuntimeConfigObject();
    if (!Array.isArray(runtime.plugin)) throw new Error("Expected plugin list");
    expect(runtime.plugin).toContain(juggleworkConfirmationGatePluginPath());

    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      scripts?: { build?: unknown };
    };
    expect(packageJson.scripts?.build).toContain("jugglework-confirmation-gate.ts");
  });

  test("keeps helper exports out of the plugin entry module", async () => {
    // OpenCode invokes every function exported by a plugin entry as a plugin
    // factory. Exporting the text predicate here made it receive PluginInput
    // and throw `text.replace is not a function`, aborting all canary tools.
    const entry = await import("./jugglework-confirmation-gate.js");
    expect(Object.keys(entry)).toEqual(["JuggleWorkConfirmationGate"]);
  });
});
