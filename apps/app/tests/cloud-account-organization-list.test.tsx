import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "../src/i18n";
import { CloudOrganizationList } from "../src/react-app/domains/settings/cloud/cloud-account-section";

describe("Cloud account organization list", () => {
  test("lists every membership and marks the active organization", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(
      <CloudOrganizationList
        activeOrgId="org-a"
        orgs={[
          { id: "org-a", name: "组织 A", slug: "org-a", role: "owner" },
          { id: "org-b", name: "组织 B", slug: "org-b", role: "member" },
        ]}
        orgsBusy={false}
        disabled={false}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("组织 A");
    expect(html).toContain("组织 B");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("已连接");
    expect(html).toContain("你可以随时切换");
  });
});
