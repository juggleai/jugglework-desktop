import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { generatePresentation, validateSpecification } from "../resources/skills/public-skills/presentation-generator/generate-presentation.mjs";

function unzipStore(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    files.set(name, buffer.subarray(dataStart, dataStart + size).toString("utf8"));
    offset = dataStart + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}

function assertValidXml(source, name) {
  const errors = [];
  const document = new DOMParser({ errorHandler: { warning() {}, error: (message) => errors.push(message), fatalError: (message) => errors.push(message) } }).parseFromString(source, "application/xml");
  assert.equal(errors.length, 0, `${name}: ${errors.join("; ")}`);
  assert.ok(document.documentElement, `${name} has no document element`);
}

const fixtures = { executive: "0B1736", editorial: "F5EFE3", minimal: "FFFFFF" };

for (const [template, background] of Object.entries(fixtures)) {
  test(`generates editable ${template} v1 OOXML with the requested page count`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "presentation-generator-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const spec = {
      version: 1, template, outputName: `${template}.pptx`,
      slides: [
        { title: `${template} title`, subtitle: "Editable subtitle", bullets: ["Editable first point", "Editable second point"] },
        { title: "Editable second slide", bullets: ["Closing point"] },
      ],
    };
    const output = await generatePresentation(spec, root, spec.outputName);
    const archive = await readFile(output);
    assert.equal(archive.subarray(0, 2).toString(), "PK");
    const files = unzipStore(archive);
    assert.ok(files.has("[Content_Types].xml"));
    assert.ok(files.has("ppt/presentation.xml"));
    for (const [name, source] of files) if (name.endsWith(".xml") || name.endsWith(".rels")) assertValidXml(source, name);
    assert.equal([...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);
    assert.match(files.get("docProps/core.xml"), new RegExp(`jugglework-template:${template}:v1`));
    assert.match(files.get("ppt/slides/slide1.xml"), new RegExp(`<a:srgbClr val="${background}"`));
    assert.match(files.get("ppt/slides/slide1.xml"), /<p:sp>/);
    assert.match(files.get("ppt/slides/slide1.xml"), /<a:t>[^<]* title<\/a:t>/);
    assert.match(files.get("ppt/slides/slide1.xml"), /<a:t>Editable first point<\/a:t>/);
    const shapeIds = [...files.get("ppt/slides/slide1.xml").matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]);
    assert.equal(new Set(shapeIds).size, shapeIds.length);
    const relationshipTargets = [...files.get("ppt/_rels/presentation.xml.rels").matchAll(/Target="slides\/(slide\d+\.xml)"/g)].map((match) => `ppt/slides/${match[1]}`);
    assert.deepEqual(relationshipTargets, ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]);
    relationshipTargets.forEach((name) => assert.ok(files.has(name), `${name} relationship target is missing`));
  });
}

test("rejects unsafe or unbounded specifications before writing", () => {
  assert.throws(() => validateSpecification({ version: 2 }), /version/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "../deck.pptx", slides: [{ title: "x" }] }), /outputName/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "deck.pptx", slides: [] }), /1-30/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "deck.pptx", slides: [{ title: "x", image: "data" }] }), /unsupported/);
});

test("bundled skill requires exactly one controlled generation call", async () => {
  const skill = await readFile(new URL("../resources/skills/public-skills/presentation-generator/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Call `jugglework_artifact_generate` exactly once/);
  assert.equal((skill.match(/jugglework_artifact_generate/g) ?? []).length, 1);
  assert.equal((skill.match(/"program": "jugglework:presentation-generator"/g) ?? []).length, 1);
  assert.doesNotMatch(skill, /"program": "node"/);
  assert.match(skill, /Do not install packages/);
  assert.match(skill, /Do not make a second generation call/);
  assert.match(skill, /`jugglework_artifact_register`/);
});
