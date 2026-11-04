import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { trackFixtureChild } from "./session-real-server-child.mjs";

test("an already-exited fixture cannot pass cleanup, including early exit zero", async () => {
  for (const code of [0, 7]) {
    const child = spawn(process.execPath, ["-e", `process.exit(${code})`], { env: {}, stdio: "ignore" });
    const fixture = trackFixtureChild(child);
    await once(child, "exit");
    assert.throws(fixture.check, /Fixture exited unexpectedly/);
    await assert.rejects(fixture.close(), /fixture (?:graceful cleanup exit code|exited before cleanup)/);
  }
});

test("cleanup checks both a newly exiting fixture's code and signal", async () => {
  for (const code of [0, 9, null]) {
    const script = `${code === null ? "" : `process.on('SIGTERM',()=>process.exit(${code}));`} process.stdout.write('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
    const fixture = trackFixtureChild(child);
    await once(child.stdout, "data");
    fixture.check();
    if (code === 0) await fixture.close();
    else await assert.rejects(fixture.close(), /fixture graceful cleanup exit code/);
  }
});
