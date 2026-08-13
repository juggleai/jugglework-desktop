import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("mounted OpenCode client cleanup boundary", () => {
  test("removes deprecated mounted session compatibility and keeps canonical client calls", () => {
    const server = source("apps/server/src/server.ts");
    const rendererAdapter = source("apps/app/src/app/lib/opencode.ts");
    const canonicalReads = source("apps/app/src/react-app/domains/session/canonical-agent-rollout.ts");

    expect(server).toContain("MOUNTED_OPENCODE_ENGINE_INTEGRATION_ROOTS");
    expect(server).not.toContain("legacyMountedOpenCodeOperation");
    expect(server).not.toContain("deprecateMountedOpenCodeResponse");
    expect(server).not.toContain("parseSessionExecutionStartProxyRequest");
    expect(rendererAdapter).not.toContain("wrapJuggleWorkReadWithFallback");
    expect(rendererAdapter).not.toContain("mountedSessionRunIds");
    expect(rendererAdapter).not.toContain("juggleworkSessionClient");
    expect(canonicalReads).not.toContain("legacy_fallback");
    expect(canonicalReads).toContain("createCanonicalAgentClient");
  });

  test("retains the engine adapter, legacy database importer, and cleanup evidence", () => {
    expect(existsSync(resolve(root, "apps/server/src/agent-engine/opencode-adapter.ts"))).toBe(true);
    expect(existsSync(resolve(root, "apps/server/src/legacy-importers/opencode-sqlite.ts"))).toBe(true);
    expect(existsSync(resolve(root, "docs/operations/opencode-mounted-client-cleanup.md"))).toBe(true);
  });
});
