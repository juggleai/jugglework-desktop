const assert = require("node:assert/strict");
const test = require("node:test");

const { hasNotaryCredentials, resolveNotaryArguments } = require("./macos-notary.cjs");

test("prefers a keychain profile without exposing API-key inputs", () => {
  assert.deepEqual(resolveNotaryArguments({
    APPLE_NOTARY_KEYCHAIN_PROFILE: "local-profile",
    APPLE_API_KEY_PATH: "/private/key.p8",
    APPLE_API_KEY: "key-id",
    APPLE_API_ISSUER: "issuer",
  }), ["--keychain-profile", "local-profile"]);
});

test("supports the legacy local profile variable and an explicit keychain", () => {
  assert.deepEqual(resolveNotaryArguments({
    JUGGLEWORK_NOTARY_PROFILE: "legacy-profile",
    APPLE_NOTARY_KEYCHAIN: "/tmp/release.keychain-db",
  }), ["--keychain", "/tmp/release.keychain-db", "--keychain-profile", "legacy-profile"]);
});

test("retains the API key fallback and rejects partial credentials", () => {
  assert.deepEqual(resolveNotaryArguments({
    APPLE_API_KEY_PATH: "/private/key.p8",
    APPLE_API_KEY: "key-id",
    APPLE_API_ISSUER: "issuer",
  }), ["--key", "/private/key.p8", "--key-id", "key-id", "--issuer", "issuer"]);
  assert.equal(hasNotaryCredentials({ APPLE_API_KEY_PATH: "/private/key.p8" }), false);
  assert.throws(() => resolveNotaryArguments({}), /Apple notarization credentials are required/);
});
