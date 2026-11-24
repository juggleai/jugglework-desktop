// A build-time package marker, not a runtime environment-variable bypass.
function isUnsignedWindowsTestPackage(platform, metadata) {
  return platform === "win32" && metadata?.juggleworkUnsignedTestPackage === true;
}

module.exports = { isUnsignedWindowsTestPackage };
