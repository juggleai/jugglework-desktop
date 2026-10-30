import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOfficeFont, configureOfficeFontResponse } from "./office-font-compat.mjs";

test("font response is reusable and validated", async () => {
  const result = await fetchOfficeFont("https://example.invalid/font", async () => new Response("font"));
  assert.equal(await (await result.blob()).text(), "font");
  assert.equal(await (await result.blob()).text(), "font");
  await assert.rejects(fetchOfficeFont("x", async () => new Response(null, { status: 503 })), /503/);
  await assert.rejects(fetchOfficeFont("x", async () => new Response("")), /no data/);
  await assert.rejects(fetchOfficeFont("x", async () => { throw new Error("network blocked"); }), /network blocked/);
});

test("deadline covers stalled fetch and stalled body consumption", async () => {
  await assert.rejects(fetchOfficeFont("x", () => new Promise(() => {}), 10), /timed out/);
  await assert.rejects(fetchOfficeFont("x", async () => ({ ok: true, blob: () => new Promise(() => {}) }), 10), /timed out/);
});

test("unknown SDK bytes are not patched", async () => {
  const response = await configureOfficeFontResponse(new Request("http://127.0.0.1:1234/static/doc/js/feature-pc-7458-6617ed03.js"), new Response("unknown version"), { origin: "http://127.0.0.1:1234" });
  assert.equal(await response.text(), "unknown version");
});
