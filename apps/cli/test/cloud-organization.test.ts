import assert from "node:assert/strict";
import test from "node:test";
import { resolveCloudOrganization } from "../src/cloud-organization.js";
import type { CloudOrganizations } from "../src/cloud-client.js";

const items = [
  { id: "org-first", slug: "first", name: "First" },
  { id: "org-last", slug: "last", name: "Last" },
];

test("organization selection prefers Cloud account state, then remembered choice, then first", () => {
  const state: CloudOrganizations = { items, activeOrgId: "org-last", activeOrgSlug: null };
  assert.equal(resolveCloudOrganization(state, { remembered: "org-first" })?.id, "org-last");
  assert.equal(resolveCloudOrganization({ ...state, activeOrgId: null }, { remembered: "org-last" })?.id, "org-last");
  assert.equal(resolveCloudOrganization({ ...state, activeOrgId: "removed" })?.id, "org-first");
  assert.equal(resolveCloudOrganization({ ...state, activeOrgId: null }, { explicit: "first" })?.id, "org-first");
  assert.equal(resolveCloudOrganization(state, { explicit: "missing" }), null);
  assert.equal(resolveCloudOrganization({ items: [], activeOrgId: null, activeOrgSlug: null }), null);
});
