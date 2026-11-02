import assert from "node:assert/strict";

/** Track fixture exits even after its readiness promise has resolved. */
export function trackFixtureChild(child) {
  let result, stopping = false;
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => { result = { code, signal, early: !stopping }; resolve(result); });
    child.once("error", error => { result = { error, early: !stopping }; resolve(result); });
  });
  const check = () => {
    if (result) throw new Error(`Fixture exited unexpectedly: ${result.error?.message ?? result.signal ?? result.code}`);
  };
  return {
    check,
    async close() {
      stopping = true;
      let kill;
      if (!result) {
        child.kill("SIGTERM");
        kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      }
      try {
        const exit = await exited;
        assert.equal(exit.error, undefined, "fixture process error");
        assert.equal(exit.code, 0, "fixture graceful cleanup exit code");
        assert.equal(exit.signal, null, "fixture graceful cleanup signal");
        assert.equal(exit.early, false, "fixture exited before cleanup");
      } finally { clearTimeout(kill); }
    },
  };
}
