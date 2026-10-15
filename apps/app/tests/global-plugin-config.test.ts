import { describe, expect, test } from "bun:test";

import { removeGlobalPluginFromConfig } from "../src/react-app/domains/settings/state/global-plugin-config";

describe("global plugin config", () => {
  test("removes the matching versioned plugin and preserves unrelated JSONC", () => {
    const input = `{
  // keep this comment
  "theme": "system",
  "plugin": ["example@1.2.3", "@scope/other@next"]
}\n`;
    const output = removeGlobalPluginFromConfig(input, "example");
    expect(output).toContain("// keep this comment");
    expect(output).toContain('"theme": "system"');
    expect(output).not.toContain("example@1.2.3");
    expect(output).toContain("@scope/other@next");
  });

  test("refuses to rewrite when the configured plugin is absent", () => {
    expect(() => removeGlobalPluginFromConfig('{"plugin":["other"]}', "missing"))
      .toThrow("Plugin is not present");
  });
});
