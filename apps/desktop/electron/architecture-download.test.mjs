import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveMacArchitectureDownloadUrl } from "./architecture-download.mjs";

const manifest = `version: 1.2.15
files:
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.zip
    sha512: ZIP
    size: 100
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.dmg
    sha512: DMG
    size: 200
path: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.zip
sha512: ZIP
`;

describe("macOS architecture replacement download", () => {
  it("fetches the stable Qiniu manifest and selects its matching DMG", async () => {
    const requests = [];
    const result = await resolveMacArchitectureDownloadUrl({
      arch: "arm64",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(manifest, { status: 200 });
      },
    });
    assert.equal(result, "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.dmg");
    assert.equal(requests[0]?.url, "https://downloads.jugglechat.cn/jugglework/releases/stable/mac/latest-mac.yml");
  });

  it("returns unavailable for a missing feed or compatible DMG", async () => {
    assert.equal(await resolveMacArchitectureDownloadUrl({
      arch: "arm64",
      fetchImpl: async () => new Response(null, { status: 404 }),
    }), null);
    assert.equal(await resolveMacArchitectureDownloadUrl({
      arch: "x64",
      fetchImpl: async () => new Response(manifest, { status: 200 }),
    }), null);
  });

  it("fails closed without trying another origin", async () => {
    let calls = 0;
    await assert.rejects(
      resolveMacArchitectureDownloadUrl({
        arch: "arm64",
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 503 });
        },
      }),
      /HTTP 503/,
    );
    assert.equal(calls, 1);
  });
});
