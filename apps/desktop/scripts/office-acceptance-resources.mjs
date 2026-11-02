import assert from "node:assert/strict";

// SDK 0.0.0.499 only, exact format + method + endpoint + 404 observations.
// No response is replaced. Full native edit/save/reopen and core/font checks
// still gate acceptance. Callers inspected in real served SDK scripts:
// auth_apply/check: readonly GuidePermitApply/checkIsApplyIn24H (sheet bundle_container_readonly_0_features).
// scenes_calc: CanaryAI feature toggles / local-storage-size-service telemetry.
// user_info/user_flag: account/VIP metadata; comment/user/info: fetchCommentVipInfo.
// PPT: weblog_tdoc_browser-a32230.js constructs the versioned logging worker;
// 7761.3a82df8e.chunk.js GET_ADDON_LIST is the online add-on catalog.
// components/docs/metadata.v1.json is component metadata: observed 404 while
// native text, commit, original-path save and all three reopen checks succeed.
const background404 = [
  { formats: ["csv", "xlsx", "docx"], method: "GET", endpoint: "/v2/user/attribute/get", category: "sdk-user-attributes" },
  { formats: ["csv", "xlsx"], method: "GET", endpoint: "/components/feature/assets.v1.json", category: "sdk-feature-configuration" },
  { formats: ["csv", "xlsx", "docx"], method: "GET", endpoint: "/cgi-bin/online_docs/user_info", category: "sdk-user-info" },
  { formats: ["csv", "xlsx"], method: "POST", endpoint: "/cgi-bin/online_docs/user_info", category: "sdk-account-metadata" },
  { formats: ["csv", "xlsx"], method: "GET", endpoint: "/cgi-bin/online_docs/auth_apply/check", category: "sdk-online-permission-application" },
  { formats: ["csv", "xlsx", "docx", "pptx"], method: "POST", endpoint: "/api/frontedcfgreader/scenes_calc", category: "sdk-feature-toggle-telemetry" },
  { formats: ["docx"], method: "POST", endpoint: "/api/vipcenter/comment/user/info", category: "sdk-comment-vip-info" },
  { formats: ["docx"], method: "POST", endpoint: "/cgi-bin/online_docs/user_flag", category: "sdk-user-flags" },
  { formats: ["pptx"], method: "GET", endpoint: "/static/slide/slides/lib/docs.qq.com/scenario/pub/wl2/browser-backend-worker-1.60.0.js", category: "sdk-weblog-worker-1.60.0" },
  { formats: ["pptx"], method: "GET", endpoint: "/addon/editor-addons", category: "sdk-online-addon-catalog" },
  { formats: ["pptx"], method: "GET", endpoint: "/components/docs/metadata.v1.json", category: "sdk-component-metadata" },
];

/** Content-free failure metadata: no request/response bodies, query values or local paths. */
export function resourceFailure(request, status, format = "csv") {
  const endpoint = new URL(request.url).pathname;
  const category = background404.find((entry) => entry.formats.includes(format) && entry.method === request.method && entry.endpoint === endpoint)?.category;
  const allowed = status === 404 && Boolean(category);
  return { method: request.method, endpoint: category ? endpoint : "<unrecognized-endpoint>",
    category: category ?? "unrecognized-resource", status, allowed };
}

export function assertOfficeResources(reports) {
  for (const report of reports) {
    assert.equal(report.coreFailures, 0, "Required Office resource failed");
    assert.equal(report.requiredMissing, 0, "Required Office resource missing");
    assert.equal(report.fontFailures, 0, "Office font resource failed");
    assert.deepEqual(report.unknownFailures.filter((failure) => !failure.allowed), [], "Unrecognized Office resource failure");
  }
}
