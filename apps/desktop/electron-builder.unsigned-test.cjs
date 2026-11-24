const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("yaml");

if (process.env.JUGGLEWORK_WINDOWS_UNSIGNED_TEST !== "1") {
  throw new Error("Set JUGGLEWORK_WINDOWS_UNSIGNED_TEST=1 to build a local unsigned test package");
}
const config = parse(fs.readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8"));
module.exports = {
  ...config,
  directories: { ...config.directories, output: "dist-electron/beishu" },
  extraMetadata: { juggleworkUnsignedTestPackage: true },
  forceCodeSigning: false,
  artifactName: config.artifactName,
};
