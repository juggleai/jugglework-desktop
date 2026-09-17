function optionalValue(environment, ...names) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return null;
}

function resolveNotaryArguments(environment = process.env) {
  const profile = optionalValue(environment, "APPLE_NOTARY_KEYCHAIN_PROFILE", "JUGGLEWORK_NOTARY_PROFILE");
  if (profile) {
    const keychain = optionalValue(environment, "APPLE_NOTARY_KEYCHAIN");
    return [
      ...(keychain ? ["--keychain", keychain] : []),
      "--keychain-profile",
      profile,
    ];
  }

  const keyPath = optionalValue(environment, "APPLE_API_KEY_PATH");
  const keyId = optionalValue(environment, "APPLE_API_KEY");
  const issuer = optionalValue(environment, "APPLE_API_ISSUER");
  if (keyPath && keyId && issuer) {
    return ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
  }

  throw new Error(
    "Apple notarization credentials are required: configure APPLE_NOTARY_KEYCHAIN_PROFILE "
      + "(or JUGGLEWORK_NOTARY_PROFILE), or APPLE_API_KEY_PATH/APPLE_API_KEY/APPLE_API_ISSUER",
  );
}

function hasNotaryCredentials(environment = process.env) {
  try {
    resolveNotaryArguments(environment);
    return true;
  } catch {
    return false;
  }
}

module.exports = { hasNotaryCredentials, resolveNotaryArguments };
