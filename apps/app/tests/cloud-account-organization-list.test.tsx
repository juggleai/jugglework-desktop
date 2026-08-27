import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "../src/i18n";
import { ConnectedOrganization } from "../src/react-app/domains/settings/cloud/cloud-account-section";

describe("Cloud account organization", () => {
  test("shows only the active organization", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(
      <ConnectedOrganization
        org={{ id: "org-a", name: "组织 A", slug: "org-a", role: "owner" }}
      />,
    );

    expect(html).toContain("组织 A");
    expect(html).not.toContain("组织 B");
    expect(html).toContain("已连接");
  });
});
