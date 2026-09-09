#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { DEFAULT_BUCKET, assertArchitecture, assertPlatform, assertReleaseVersion } from "./constants.mjs";
import {
  appendAuditRecord,
  assertCanary,
  assertEvidenceMatchesPlan,
  assertLocalVerification,
  assertNoSecrets,
  createEvidence,
  replaceEvidence,
  withEvidenceResults,
  writeEvidence,
} from "./evidence.mjs";
import { createReleasePlan, printablePlan } from "./plan.mjs";
import { createQshellAdapter } from "./qshell.mjs";
import { promoteChannel, recoverPromotionLock, uploadVersion, verifyCdn } from "./workflow.mjs";

const COMMANDS = new Set([
  "plan",
  "build",
  "verify-local",
  "upload-version",
  "verify-cdn",
  "promote-channel",
  "verify-only",
  "resume",
  "recover-lock",
]);
const OPTIONS = new Set([
  "version", "channel", "platform", "arch", "dist", "evidence", "bucket", "releaseDate", "actor", "reason",
  "audit", "commit", "localVerification", "canary", "notarizationExceptionReason", "preCanaryExceptionReason",
]);

export function parseArguments(argv) {
  const [command, ...allTokens] = argv;
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command || "<missing>"}`);
  const separator = allTokens.indexOf("--");
  const tokens = separator === -1 ? allTokens : allTokens.slice(0, separator);
  const commandArgv = separator === -1 ? [] : allTokens.slice(separator + 1);
  if (separator !== -1 && command !== "build") throw new Error("Only build accepts a command after --");
  const options = { dryRun: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!OPTIONS.has(name)) throw new Error(`Unknown option: --${rawName}`);
    const value = inline ?? tokens[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${rawName}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${rawName}`);
    options[name] = value;
  }
  for (const name of ["version", "channel", "platform", "arch", "dist", "evidence"]) {
    if (!options[name]) throw new Error(`Missing required --${name}`);
  }
  options.architectures = options.arch.split(",").map((value) => value.trim()).filter(Boolean);
  if (options.architectures.length === 0) throw new Error("--arch must contain at least one architecture");
  if (new Set(options.architectures).size !== options.architectures.length) throw new Error("Duplicate architectures are not allowed");
  assertReleaseVersion(options.version, options.channel);
  assertPlatform(options.platform);
  options.architectures.forEach(assertArchitecture);
  if (options.architectures.includes("universal") && options.architectures.length !== 1) {
    throw new Error("Universal architecture cannot be combined with architecture-specific artifacts");
  }
  if (command === "build" && commandArgv.length === 0) throw new Error("build requires a command argv after --");
  if (command === "recover-lock" && !options.audit) throw new Error("recover-lock requires --audit PATH");
  if (command === "verify-local" && (!options.commit || !options.localVerification)) {
    throw new Error("verify-local requires --commit and --local-verification PATH");
  }
  return { command, commandArgv, options };
}

async function loadJson(filePath, label, read = readFile) {
  try {
    return assertNoSecrets(JSON.parse(await read(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Unable to read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadEvidence(filePath, read) {
  return loadJson(filePath, "release evidence", read);
}

function executeArgv(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) resolve({ status: 0 });
      else reject(new Error(`Build command failed with ${signal ? `signal ${signal}` : `status ${status}`}`));
    });
  });
}

export async function runCli(argv, {
  run,
  execute = executeArgv,
  fetchImpl,
  read = readFile,
  output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  qiniu: injectedQiniu,
  refresh,
  readBack,
  writeNewEvidence = writeEvidence,
  updateEvidence = replaceEvidence,
  appendAudit = appendAuditRecord,
  now = () => new Date(),
} = {}) {
  const { command, commandArgv, options } = parseArguments(argv);
  if (command === "build") {
    const result = options.dryRun
      ? { ok: true, command, dryRun: true, executable: commandArgv[0], argumentCount: commandArgv.length - 1, executed: false }
      : { ok: true, command, dryRun: false, ...(await execute(commandArgv)), executed: true };
    output(result);
    return result;
  }
  const qiniu = injectedQiniu ?? createQshellAdapter({ bucket: options.bucket ?? DEFAULT_BUCKET, run });
  if (command === "recover-lock") {
    const result = await recoverPromotionLock({
      channel: options.channel,
      qiniu,
      reason: options.reason,
      actor: options.actor,
      dryRun: options.dryRun,
      now,
      onAudit: (record) => appendAudit(options.audit, record),
    });
    output({ ...result, auditPath: options.audit });
    return result;
  }
  const plan = await createReleasePlan({
    version: options.version,
    channel: options.channel,
    platform: options.platform,
    architectures: options.architectures,
    dist: options.dist,
    releaseDate: options.releaseDate,
    persistManifest: command === "plan" && !options.dryRun,
  });
  if (command === "plan") {
    const result = { ok: true, command, dryRun: options.dryRun, evidencePath: options.evidence, plan: printablePlan(plan) };
    output(result);
    return result;
  }
  if (command === "verify-local") {
    const localVerification = assertLocalVerification(plan, await loadJson(options.localVerification, "local verification", read), { stable: false });
    const canary = options.canary ? assertCanary(plan, await loadJson(options.canary, "canary verification", read)) : null;
    const evidence = createEvidence({ plan, commit: options.commit, localVerification, canary, timestamps: { createdAt: now().toISOString() } });
    if (!options.dryRun) await writeNewEvidence(options.evidence, evidence);
    const result = { ok: true, command, dryRun: options.dryRun, evidencePath: options.evidence, plan: printablePlan(plan), evidence };
    output(result);
    return result;
  }
  if (command === "upload-version" || command === "resume") {
    const checks = await uploadVersion(plan, { qiniu, resume: command === "resume", dryRun: options.dryRun });
    if (!options.dryRun) {
      const evidence = await loadEvidence(options.evidence, read);
      assertEvidenceMatchesPlan(plan, evidence);
      await updateEvidence(options.evidence, withEvidenceResults(evidence, {
        workflow: { immutable: { status: "verified", qiniuChecks: checks, verifiedAt: now().toISOString() } },
      }, now().toISOString()));
    }
    output(checks);
    return checks;
  }
  if (command === "verify-cdn" || command === "verify-only") {
    const result = await verifyCdn(plan, { qiniu, fetchImpl });
    if (!options.dryRun) {
      const evidence = await loadEvidence(options.evidence, read);
      assertEvidenceMatchesPlan(plan, evidence);
      const canary = options.canary ? assertCanary(plan, await loadJson(options.canary, "canary verification", read)) : evidence.canary;
      await updateEvidence(options.evidence, withEvidenceResults(evidence, {
        canary,
        workflow: { cdn: { status: "verified", ...result, verifiedAt: now().toISOString() } },
      }, now().toISOString()));
    }
    output(result);
    return result;
  }
  const evidence = await loadEvidence(options.evidence, read);
  if (command === "promote-channel") {
    const result = await promoteChannel(plan, evidence, {
      qiniu,
      refresh: refresh ?? qiniu.refresh?.bind(qiniu),
      readBack,
      fetchImpl,
      dryRun: options.dryRun,
      actor: options.actor,
      notarizationExceptionReason: options.notarizationExceptionReason,
      preCanaryExceptionReason: options.preCanaryExceptionReason,
      now,
    });
    if (!options.dryRun) {
      await updateEvidence(options.evidence, withEvidenceResults(evidence, {
        workflow: { promotion: {
          status: "verified",
          channelKey: result.channelKey,
          readBack: result.readBack,
          notarizationException: result.notarizationException,
          preCanaryException: result.preCanaryException,
          promotedAt: now().toISOString(),
        } },
      }, now().toISOString()));
    }
    output(result);
    return result;
  }
  throw new Error(`Unhandled command: ${command}`);
}

export function usage() {
  return `Usage: node cli.mjs <command> --version VERSION --channel stable|alpha --platform mac --arch arm64[,x64|universal] --dist PATH --evidence PATH [options] [-- argv...]\n\nStable requires X.Y.Z; alpha also accepts SemVer prereleases. build executes argv after -- without a shell. recover-lock requires --audit PATH. Audited notarization exceptions are restricted to stable 1.2.15/1.2.16; the audited pre-canary exception is restricted to stable 1.2.16.\nCommands: plan, build, verify-local, upload-version, verify-cdn, promote-channel, verify-only, resume, recover-lock\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 1;
  }
}
