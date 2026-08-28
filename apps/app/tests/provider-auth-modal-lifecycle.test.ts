import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const modalSource = readFileSync(
  new URL("../src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(new URL("../src/components/ui/dialog.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");

describe("provider auth modal lifecycle", () => {
  test("keeps dialog controls interactive inside the macOS titlebar region", () => {
    expect(dialogSource).toContain("mac:titlebar-no-drag");
  });

  test("resets modal presentation only after the close transition completes", () => {
    const handleClose = modalSource.slice(
      modalSource.indexOf("const handleClose"),
      modalSource.indexOf("useEffect(() =>", modalSource.indexOf("const handleClose")),
    );
    expect(handleClose).not.toContain("resetState()");
    expect(modalSource).toMatch(/onOpenChangeComplete=\{\(open\) => \{[\s\S]+resetState\(\);[\s\S]+props\.onAfterClose\?\.\(\)/);
    expect(routeSource).toContain("onAfterClose={() => setEditingLocalProvider(null)}");
  });

  test("drops the unreachable custom-draft branch from the back handler", () => {
    const handleBack = modalSource.slice(
      modalSource.indexOf("const handleBack"),
      modalSource.indexOf("const submittingLabel"),
    );
    expect(handleBack).not.toContain("handleClose()");
  });

  test("places Edit in the detail header instead of the former Close action", () => {
    expect(modalSource).toMatch(/isViewingCustomProvider \? \([\s\S]+setCustomProviderEditing\(true\)[\s\S]+t\("common\.edit"\)/);
    expect(modalSource).not.toContain('t(hasCustomProviderDraft ? "common.close" : "common.back")');
  });
});
