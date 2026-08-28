import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("Cloud account actions", () => {
  test("keeps destructive credential management and account actions out of settings", () => {
    const account = readFileSync(
      new URL("../src/react-app/domains/settings/cloud/cloud-account-section.tsx", import.meta.url),
      "utf8",
    );
    const remoteControl = readFileSync(
      new URL("../src/react-app/domains/settings/cloud/desktop-remote-control-section.tsx", import.meta.url),
      "utf8",
    );

    expect(account).not.toContain("den.open_dashboard");
    expect(account).not.toContain("den.sign_out");
    expect(remoteControl).not.toContain("删除本机设备凭据");
    expect(remoteControl).not.toContain("desktopRemoteControlCredentialDelete");
  });
});
