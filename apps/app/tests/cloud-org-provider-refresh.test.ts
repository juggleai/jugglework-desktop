import { describe, expect, test } from "bun:test";

import { shouldClearCloudOrgProvidersAfterFailure } from "../src/react-app/domains/connections/provider-auth/store";

describe("cloud organization provider refresh retention", () => {
  test("retains the last good directory after a transient failure in the same organization", () => {
    expect(shouldClearCloudOrgProvidersAfterFailure("https://den::org_a", "https://den::org_a"))
      .toBe(false);
  });

  test("clears the directory when no prior context exists or the organization changes", () => {
    expect(shouldClearCloudOrgProvidersAfterFailure("", "https://den::org_a")).toBe(true);
    expect(shouldClearCloudOrgProvidersAfterFailure("https://den::org_a", "https://den::org_b"))
      .toBe(true);
  });
});
