#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

import { assertEvidenceMatchesPlan, assertPromotionEvidence, replaceEvidence, withEvidenceResults } from "./evidence.mjs";
import { createReleasePlan } from "./plan.mjs";

export const BRIDGE_VERSION = "1.2.15";
export const BRIDGE_CHANNEL = "stable";
export const BRIDGE_PLATFORM = "mac";
export const BRIDGE_ARCHITECTURES = ["arm64"];

async function loadVerifiedBridge(directory) {
  const evidencePath = path.join(directory, "qiniu-release-evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const plan = await createReleasePlan({
    version: BRIDGE_VERSION,
    channel: BRIDGE_CHANNEL,
    platform: BRIDGE_PLATFORM,
    architectures: BRIDGE_ARCHITECTURES,
    dist: directory,
  });
  assertEvidenceMatchesPlan(plan, evidence);
  assertPromotionEvidence(plan, evidence);
  if (evidence.workflow?.promotion?.status !== "verified"
    || evidence.workflow.promotion.channelKey !== plan.channelManifest.key
    || evidence.workflow.promotion.readBack?.sha256 !== plan.manifest.sha256
    || evidence.workflow.promotion.readBack?.size !== plan.manifest.size) {
    throw new Error("The GitHub bridge requires verified stable Qiniu promotion and CDN read-back evidence");
  }
  return { evidence, evidencePath, plan };
}

export async function verifyGitHubBridgeBundle({ directory, outputManifest }) {
  const { evidence, plan } = await loadVerifiedBridge(directory);
  const retainedManifest = path.join(directory, `qiniu-v${BRIDGE_VERSION}-latest-mac.yml`);
  const retainedBytes = await readFile(retainedManifest);
  if (!retainedBytes.equals(Buffer.from(plan.manifest.content, "utf8"))) {
    throw new Error("The retained Qiniu manifest bytes do not match the verified release plan");
  }
  const output = outputManifest ?? path.join(directory, "latest-mac.yml");
  await copyFile(retainedManifest, output, fsConstants.COPYFILE_EXCL);
  return { plan, evidence, output };
}

export async function recordGitHubBridgeEvidence({ directory, releaseId, tag = "v1.2.15", now = new Date().toISOString() }) {
  if (tag !== "v1.2.15") throw new Error(`Unsupported GitHub bridge tag: ${tag}`);
  if (!/^\d+$/.test(String(releaseId ?? ""))) throw new Error("GitHub bridge release ID must be numeric");
  const { evidence, evidencePath } = await loadVerifiedBridge(directory);
  const updated = withEvidenceResults(evidence, {
    bridge: { githubReleaseId: String(releaseId), githubTag: tag },
  }, now);
  await replaceEvidence(evidencePath, updated);
  return updated;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

async function main() {
  const directory = readArg("--directory");
  const outputManifest = readArg("--output-manifest");
  const releaseId = readArg("--record-release-id");
  const tag = readArg("--tag") || "v1.2.15";
  if (!directory) throw new Error("Pass --directory PATH");
  if (releaseId) {
    const evidence = await recordGitHubBridgeEvidence({ directory: path.resolve(directory), releaseId, tag });
    process.stdout.write(`${JSON.stringify({ ok: true, version: evidence.version, bridge: evidence.bridge }, null, 2)}\n`);
    return;
  }
  const result = await verifyGitHubBridgeBundle({ directory: path.resolve(directory), outputManifest: outputManifest ? path.resolve(outputManifest) : undefined });
  const parsedManifest = parse(await readFile(result.output, "utf8"));
  process.stdout.write(`${JSON.stringify({ ok: true, version: result.plan.version, files: parsedManifest.files.map((file) => file.url), manifest: result.output }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
