import assert from "node:assert/strict";
import test from "node:test";
import { CliRenderer, redactSecrets } from "../src/render.js";

test("redacts nested credentials but preserves non-secret source labels", () => {
  assert.deepEqual(redactSecrets({
    token: "top-secret",
    opencode: { username: "user", password: "pass" },
    tokenSource: { client: "cli" },
  }), {
    token: "[REDACTED]",
    opencode: { username: "[REDACTED]", password: "[REDACTED]" },
    tokenSource: { client: "cli" },
  });
});

test("redacts registered token values embedded in strings", () => {
  assert.deepEqual(redactSecrets({
    message: "request Bearer actual-token failed; host actual-host-token",
    nested: ["actual-token"],
  }, ["actual-token", "actual-host-token"]), {
    message: "request Bearer [REDACTED] failed; host [REDACTED]",
    nested: ["[REDACTED]"],
  });
});

test("renderer registration redacts values in NDJSON errors", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new CliRenderer({ json: true, color: false });
    renderer.registerSecretValues(["actual-token", "actual-host-token"]);
    renderer.error("actual-token and actual-host-token were rejected");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!), {
    type: "error",
    message: "[REDACTED] and [REDACTED] were rejected",
  });
});

test("renderer registration redacts reflected secrets in human output", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const renderer = new CliRenderer({ json: false, color: false });
    renderer.registerSecretValues(["actual-token"]);
    renderer.banner({ id: "ws", name: "actual-token workspace" }, "https://actual-token@example.test", false);
    renderer.session({ id: "ses", title: "actual-token title" });
    renderer.delta("answer actual-token");
    renderer.ensureLine();
  } finally {
    process.stdout.write = original;
  }
  assert.doesNotMatch(writes.join(""), /actual-token/);
  assert.match(writes.join(""), /\[REDACTED\]/);
});

test("interactive welcome fits a narrow terminal and redacts secrets", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  const stream = process.stdout as typeof process.stdout & { columns?: number };
  const columns = stream.columns;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  stream.columns = 48;
  try {
    const renderer = new CliRenderer({ json: false, color: false });
    renderer.registerSecretValues(["hidden-token"]);
    renderer.welcome({
      workspace: { id: "ws", path: "/a/very/long/path/to/hidden-token/workspace" },
      model: "provider/model",
      sandbox: "workspace-write",
      approval: "on-request",
      cloud: "saved login: hidden-token@example.test · org my-org",
      owned: true,
    });
    assert.equal(renderer.promptLabel(), "› ");
  } finally {
    process.stdout.write = original;
    stream.columns = columns;
  }
  const output = writes.join("");
  const lines = output.trim().split("\n");
  assert.equal(lines.length, 9);
  assert.ok(lines.every((line) => line.length === 48));
  assert.match(output, />_ JuggleWork \(v/);
  assert.match(output, /model:\s+provider\/model/);
  assert.match(output, /directory:\s+….*workspace/);
  assert.match(output, /saved login:/);
  assert.doesNotMatch(output, /hidden-token/);
});

test("interactive task display keeps the submitted prompt and context bounded and redacted", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  const stream = process.stdout as typeof process.stdout & { columns?: number; isTTY?: boolean };
  const columns = stream.columns;
  const isTTY = stream.isTTY;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  stream.columns = 32;
  stream.isTTY = true;
  try {
    const renderer = new CliRenderer({ json: false, color: false });
    renderer.registerSecretValues(["secret-value"]);
    renderer.submittedPrompt("list secret-value files\nmore");
    renderer.taskContext("provider/model", { id: "ws", path: "/long/path/secret-value/workspace" });
    renderer.startWorking();
    renderer.session({ id: "ses_1", title: "test" });
    renderer.info("Preparing task");
    renderer.assistantStart();
    renderer.tool("read", "running");
    renderer.delta("done\n");
    renderer.stopWorking();
  } finally {
    process.stdout.write = original;
    stream.columns = columns;
    stream.isTTY = isTTY;
  }
  const output = writes.join("");
  assert.match(output, /› list \[REDACTED\] files more/);
  assert.match(output, /provider\/model · .*workspace/);
  assert.match(output, /Working \(0s · esc to stop\)/);
  assert.match(output, /Preparing task/);
  assert.match(output, /\u001b\[2Ksession ses_1 test\n/);
  assert.match(output, /● JuggleWork\n/);
  assert.match(output, /• read running/);
  assert.match(output, /done\n/);
  assert.doesNotMatch(output, /secret-value/);
  assert.equal(output.split("\n")[0]!.length, 32);
});

test("composer keeps model footer below the cursor and highlights selected choices", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  const stream = process.stdout as typeof process.stdout & { columns?: number };
  const columns = stream.columns;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  stream.columns = 60;
  try {
    const renderer = new CliRenderer({ json: false, color: true });
    renderer.registerSecretValues(["hidden-token"]);
    renderer.composerFrame("/ hidden-token", "/", [{ label: "/model", detail: "Choose model", selected: true }], "openai/gpt-6 · high reasoning", "Commands");
    renderer.clearComposer();
  } finally {
    process.stdout.write = original;
    stream.columns = columns;
  }
  const output = writes.join("");
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(output, /Commands.*\/model.*Choose model/s);
  assert.match(output, /\u001b\[48;5;75m/);
  assert.match(plain, /› \/ \[REDACTED\]\nopenai\/gpt-6 · high reasoning/s);
  assert.doesNotMatch(output, /hidden-token/);
});

test("task display does not decorate JSON or exec output", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    for (const options of [{ json: true, color: false }, { json: false, color: false, exec: true }]) {
      const renderer = new CliRenderer(options);
      renderer.submittedPrompt("private task");
      renderer.taskContext("runtime default", { id: "ws" });
      renderer.startWorking();
      renderer.stopWorking();
    }
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(writes, []);
});

test("interactive task row replaces only an unwrapped readline input", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  const stream = process.stdout as typeof process.stdout & { columns?: number; isTTY?: boolean };
  const columns = stream.columns;
  const isTTY = stream.isTTY;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  stream.columns = 24;
  stream.isTTY = true;
  try {
    const renderer = new CliRenderer({ json: false, color: true });
    renderer.submittedPrompt("short task", true);
    renderer.submittedPrompt("this task is much too long to fit on one line", true);
  } finally {
    process.stdout.write = original;
    stream.columns = columns;
    stream.isTTY = isTTY;
  }
  const output = writes.join("");
  assert.equal(output.split("\u001b[1A\r\u001b[2K").length - 1, 1);
  assert.match(output, /short task/);
  assert.doesNotMatch(output, /this task is much/);
});

test("slash palette lists only supplied commands and fits a narrow terminal", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  const stream = process.stdout as typeof process.stdout & { columns?: number; isTTY?: boolean };
  const columns = stream.columns;
  const isTTY = stream.isTTY;
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  stream.columns = 36;
  stream.isTTY = true;
  try {
    new CliRenderer({ json: false, color: false }).slashPalette([
      { name: "model", summary: "Show model and reasoning effort" },
      { name: "status", summary: "Show runtime and task status" },
    ]);
  } finally {
    process.stdout.write = original;
    stream.columns = columns;
    stream.isTTY = isTTY;
  }
  const output = writes.join("");
  assert.match(output, /Commands · type a name/);
  assert.match(output, /\/model/);
  assert.match(output, /\/status/);
  assert.doesNotMatch(output, /\/vim/);
  assert.ok(output.split("\n").slice(1).every((line) => line.length <= 36));
});

test("plain exec keeps tool progress off stdout", () => {
  const output: string[] = [];
  const errors: string[] = [];
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const renderer = new CliRenderer({ json: false, color: false, exec: true });
    renderer.tool("read", "running");
    renderer.delta("partial");
    renderer.final("final answer", "ses_1");
  } finally {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
  assert.equal(output.join(""), "final answer\n");
  assert.match(errors.join(""), /• read running/);
});

test("human task output preserves newlines while removing terminal control sequences", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    const renderer = new CliRenderer({ json: false, color: false });
    renderer.assistantStart();
    renderer.delta("first\u001b[2J\rsecond\n- item\n");
    renderer.final("", "ses_1");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(writes.join(""), "● JuggleWork\nfirst\nsecond\n- item\n");
});
