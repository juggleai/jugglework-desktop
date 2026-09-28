import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "jugglework-server";
import { JuggleWorkApiClient } from "../src/api.js";
import { loadAvailableModels } from "../src/model-catalog.js";
import { resolveModelContext } from "../src/model-context.js";

test("CLI startup and model picker read providers through the real Server workspace proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-provider-route-"));
  const providerRequests: Array<string | undefined> = [];
  const catalog = {
    connected: ["lpr_example"],
    default: { lpr_example: "model-a" },
    all: [{ id: "lpr_example", models: { "model-a": { name: "Model A", variants: { high: {} } } } }],
  };
  const engine = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname === "/provider") {
      providerRequests.push(request.headers["x-opencode-directory"] as string | undefined);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(catalog));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const address = engine.address();
    assert.ok(address && typeof address === "object");
    server = await startServer({
      host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
      token: "cli-test-token", hostToken: "cli-test-host", approval: { mode: "manual", timeoutMs: 100 },
      corsOrigins: [], authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
      tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
      workspaces: [{ id: "ws_test", name: "Test", path: root, preset: "starter", workspaceType: "local",
        baseUrl: `http://127.0.0.1:${address.port}` }],
    }, { logger: { log: () => {} } });
    const api = new JuggleWorkApiClient(`http://127.0.0.1:${server.port}`, "cli-test-token", "cli-test-host");
    assert.deepEqual(await api.providerList("ws_test"), catalog);
    assert.deepEqual(await loadAvailableModels(api, { id: "ws_test" }), [{
      id: "lpr_example/model-a", provider: "lpr_example", model: "model-a", label: "Model A", variants: ["high"],
    }]);
    assert.deepEqual(await resolveModelContext(api, { id: "ws_test" }, { model: null, reasoningEffort: "high" }), {
      provider: "lpr_example", model: "model-a", reasoningEffort: "high", source: "runtime",
    });
    assert.equal(providerRequests.length, 3);
    assert.ok(providerRequests.every((directory) => directory === root));
  } finally {
    await server?.stop();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
