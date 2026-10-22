import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AutomationDefinition } from "@jugglework/types/automation";
import { nameAutomation } from "./naming.js";

test("naming summarizes task and cleans up its tool-free temporary session; failures preserve a usable name", async () => {
  const root = await mkdtemp(join(tmpdir(), "jw-naming-"));
  const definition = { name: "每天汇总行业新闻", model: { mode: "auto" }, prompt: { version: 1, parts: [{ type: "text", text: "每天汇总行业新闻" }] } } as AutomationDefinition;
  let deleted = 0;
  try {
    await nameAutomation(definition, () => ({ session: {
      create: async (input: { permission: unknown }) => { assert.deepEqual(input.permission, [{ permission: "*", pattern: "*", action: "deny" }]); return { data: { id: "naming" } }; },
      prompt: async (input: { tools: unknown }) => { assert.deepEqual(input.tools, {}); return { data: { parts: [{ type: "text", text: '{"title":"行业新闻日报","directoryName":"Daily Industry News"}' }] } }; },
      delete: async () => { deleted++; },
    } }) as never, false, root);
    assert.equal(definition.name, "行业新闻日报");
    assert.equal(definition.directoryName, "daily_industry_news");
    await nameAutomation(definition, () => ({ session: {
      create: async () => ({ data: { id: "failed-naming" } }),
      prompt: async () => { throw new Error("offline"); },
      delete: async () => { deleted++; },
    } }) as never, true, root);
    assert.equal(deleted, 2);
    assert.equal(definition.name, "行业新闻日报");
    assert.equal(definition.directoryName, "daily_industry_news");
  } finally { await rm(root, { recursive: true, force: true }); }
});
