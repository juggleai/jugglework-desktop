const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const generatorRelativePath = path.join("skills", "public-skills", "presentation-generator", "generate-presentation.mjs");
const skillRelativePath = path.join("skills", "public-skills", "presentation-generator", "SKILL.md");

function assertRegularFile(filePath, label) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { throw new Error(`Missing packaged ${label}: ${filePath}`); }
  if (!stat.isFile()) throw new Error(`Packaged ${label} is not a regular file: ${filePath}`);
}

function verifyPackagedPresentationGenerator({ runtime, resourcesPath, timeoutMs = 30_000 }) {
  assertRegularFile(runtime, "Electron runtime");
  const generator = path.join(resourcesPath, generatorRelativePath);
  const skill = path.join(resourcesPath, skillRelativePath);
  assertRegularFile(generator, "presentation generator");
  assertRegularFile(skill, "presentation skill");

  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jugglework-packaged-presentation-"));
  const outputName = "install-ready-smoke.pptx";
  const specification = {
    version: 2,
    template: "minimal",
    outputName,
    slides: [{ layout: "cover", title: "安装即用验证", subtitle: "Packaged runtime smoke test" }],
  };
  try {
    const environment = {
      ...process.env,
      PATH: "",
      ELECTRON_RUN_AS_NODE: "1",
      JUGGLEWORK_ARTIFACT_DIR: outputDirectory,
      TMPDIR: outputDirectory,
      TEMP: outputDirectory,
      TMP: outputDirectory,
    };
    // Test runners and developer shells may inject Node boot flags that do not
    // exist in a clean installation and can prevent Electron's Node mode from
    // executing the requested script.
    for (const name of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) delete environment[name];
    const result = spawnSync(runtime, [
      generator,
      "--spec-json", JSON.stringify(specification),
      "--output", outputName,
    ], {
      cwd: outputDirectory,
      env: environment,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) throw new Error(`Packaged presentation generator could not start: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`Packaged presentation generator exited with status ${result.status}: ${(result.stderr || result.stdout || "no output").trim()}`);
    }
    const entries = fs.readdirSync(outputDirectory).sort();
    if (entries.length !== 1 || entries[0] !== outputName) {
      throw new Error(`Packaged presentation generator produced unexpected files: ${entries.join(", ") || "none"}`);
    }
    const outputPath = path.join(outputDirectory, outputName);
    const archive = fs.readFileSync(outputPath);
    if (archive.length < 22 || archive.subarray(0, 2).toString("ascii") !== "PK") {
      throw new Error("Packaged presentation generator did not create an OOXML ZIP package");
    }
    return { runtime, generator, skill, outputBytes: archive.length, pathSearchDisabled: true };
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

module.exports = { generatorRelativePath, skillRelativePath, verifyPackagedPresentationGenerator };
