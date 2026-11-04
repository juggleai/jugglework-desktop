import { test } from "node:test";
import assert from "node:assert/strict";
import { assertOfficeResources, resourceFailure } from "./office-acceptance-resources.mjs";

const report = (changes = {}) => ({ coreFailures: 0, requiredMissing: 0, fontFailures: 0, unknownFailures: [], ...changes });
const request = (path, method = "GET") => ({ url: `http://127.0.0.1:12345${path}`, method });
test("CSV accepts only exact observed SDK background GET 404, without exposing query values", () => {
  const failure = resourceFailure(request("/v2/user/attribute/get?private=synthetic-canary"), 404);
  assert.equal(failure.allowed, true);
  assert.ok(!JSON.stringify(failure).includes("synthetic-canary"));
  assertOfficeResources([report({ unknownFailures: [failure] })]);
  for (const status of [500, "transport-error"]) assert.throws(() => assertOfficeResources([
    report({ unknownFailures: [resourceFailure(request("/v2/user/attribute/get"), status)] }),
  ]));
  assert.throws(() => assertOfficeResources([report({ unknownFailures: [resourceFailure(request("/v2/user/attribute/get", "POST"), 404)] })]));
});
test("background exceptions are scoped by exact format, method, endpoint and status", () => {
  for (const format of ["csv", "xlsx"]) {
    const endpoint = "/cgi-bin/online_docs/auth_apply/check";
    assert.equal(resourceFailure(request(endpoint), 404, format).allowed, true);
    for (const status of [403, 500, 503, "transport-error"]) assert.equal(resourceFailure(request(endpoint), status, format).allowed, false);
    assert.equal(resourceFailure(request(endpoint, "POST"), 404, format).allowed, false);
    assert.equal(resourceFailure(request(`${endpoint}/extra`), 404, format).allowed, false);
  }
  for (const format of ["docx", "pptx", "unknown"]) assert.equal(resourceFailure(request("/cgi-bin/online_docs/auth_apply/check"), 404, format).allowed, false);
  assert.equal(resourceFailure(request("/api/vipcenter/comment/user/info", "POST"), 404, "docx").allowed, true);
  assert.equal(resourceFailure(request("/api/vipcenter/comment/user/info", "POST"), 404, "csv").allowed, false);
  const worker = "/static/slide/slides/lib/docs.qq.com/scenario/pub/wl2/browser-backend-worker-1.60.0.js";
  assert.equal(resourceFailure(request(worker), 404, "pptx").allowed, true);
  assert.equal(resourceFailure(request(worker.replace("1.60.0", "1.60.1")), 404, "pptx").allowed, false);
  assert.equal(resourceFailure(request(worker), 503, "pptx").allowed, false);
  assert.equal(resourceFailure(request(worker), 404, "xlsx").allowed, false);
  assert.equal(resourceFailure(request("/components/docs/metadata.v1.json/extra"), 404, "pptx").allowed, false);
});
test("required/font failures and unknown static failures cannot pass acceptance", () => {
  for (const key of ["coreFailures", "requiredMissing", "fontFailures"]) assert.throws(() => assertOfficeResources([report({ [key]: 1 })]));
  const failure = resourceFailure(request("/static/sheet/required.js?private=canary"), 404);
  assert.equal(failure.endpoint, "<unrecognized-endpoint>");
  assert.throws(() => assertOfficeResources([report({ unknownFailures: [failure] })]));
});
