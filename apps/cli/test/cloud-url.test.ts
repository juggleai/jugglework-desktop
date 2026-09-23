import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCloudUrl } from "../src/cloud-url.js";

test("normalizes supported Cloud deployment forms", () => {
  for (const input of ["https://cloud.example", "https://cloud.example/", "https://cloud.example/jwork", "https://cloud.example/jwork/api"]) {
    assert.deepEqual(normalizeCloudUrl(input), {
      origin: "https://cloud.example",
      controlPlaneUrl: "https://cloud.example/jwork",
      apiBaseUrl: "https://cloud.example/jwork/api",
      catalogUrl: "https://cloud.example/jwork/models/api.json",
    });
  }
  assert.equal(normalizeCloudUrl("https://cloud.example/api/den").apiBaseUrl, "https://cloud.example/api/den");
  assert.equal(normalizeCloudUrl(null).origin, "https://work.jugglechat.cn");
});

test("rejects unsafe or ambiguous Cloud URLs", () => {
  for (const input of [
    "https://user:secret@cloud.example",
    "https://cloud.example?token=secret",
    "https://cloud.example#fragment",
    "https://cloud.example/other",
    "http://cloud.example",
  ]) assert.throws(() => normalizeCloudUrl(input));
  assert.equal(normalizeCloudUrl("http://127.0.0.1:9000/jwork").origin, "http://127.0.0.1:9000");
});
