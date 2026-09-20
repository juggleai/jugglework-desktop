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
