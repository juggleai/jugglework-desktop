import { describe, expect, test } from "bun:test";

import { revealLabelKey } from "../src/react-app/domains/session/files/file-tree-actions";

describe("file tree context menu labels", () => {
  test("uses native file manager names on macOS and Windows", () => {
    expect(revealLabelKey("darwin")).toBe("workspace_list.reveal_finder");
    expect(revealLabelKey("windows")).toBe("workspace_list.reveal_explorer");
  });

  test("uses a generic file manager label on Linux and web", () => {
    expect(revealLabelKey("linux")).toBe("workspace_list.reveal_file_manager");
    expect(revealLabelKey(null)).toBe("workspace_list.reveal_file_manager");
  });
});
