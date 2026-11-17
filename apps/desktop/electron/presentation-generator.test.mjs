import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

function resolveRelationshipTarget(relsName, target) {
  const sourcePart = relsName === "_rels/.rels"
    ? ""
    : relsName.replace(/\/_rels\/([^/]+)\.rels$/, "/$1");
  const base = sourcePart.includes("/") ? sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1) : "";
  return path.posix.normalize(path.posix.join(base, target));
}

function assertClosedPackage(files) {
  for (const [name, source] of files) {
    if (!name.endsWith(".rels")) continue;
    const relationships = [...source.matchAll(/<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"([^>]*)\/>/g)];
    assert.equal(new Set(relationships.map((match) => match[1])).size, relationships.length, `${name} has duplicate relationship ids`);
    for (const [, , target, tail] of relationships) {
      if (/TargetMode="External"/.test(tail)) continue;
      const resolved = resolveRelationshipTarget(name, target);
      assert.ok(files.has(resolved), `${name} points to missing ${resolved}`);
    }
  }
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
    assertClosedPackage(files);
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
  assert.throws(() => validateSpecification({ version: 3 }), /version/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "../deck.pptx", slides: [{ title: "x" }] }), /outputName/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "deck.pptx", slides: [] }), /1-30/);
  assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "deck.pptx", slides: [{ title: "x", image: "data" }] }), /unsupported/);
  for (const outputName of ["CON.pptx", "NUL.pptx", "deck?.pptx", "deck .pptx", "a:b.pptx"]) {
    assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName, slides: [{ title: "x" }] }), /outputName/);
  }
  for (const title of ["bad\uFFFEtext", "bad\uD800text"]) {
    assert.throws(() => validateSpecification({ version: 1, template: "minimal", outputName: "deck.pptx", slides: [{ title }] }), /invalid XML/);
  }
});

const v2Slides = [
  { layout: "cover", title: "年度经营复盘", subtitle: "从增长质量到下一阶段重点", kicker: "MANAGEMENT REVIEW", notes: "开场先讲结论，控制在一分钟。" },
  { layout: "agenda", title: "今天讨论四件事", items: ["经营结果", "增长驱动", "核心风险", "下一步行动"] },
  { layout: "section", title: "增长质量优于规模扩张", subtitle: "先看结果，再解释驱动因素", sectionNumber: "01" },
  { layout: "bullets", title: "核心结论", takeaway: "收入增长与单位经济性同步改善", bullets: ["收入同比增长 18%", "续费率提高 6 个百分点", "获客成本连续两个季度下降"] },
  { layout: "cards", title: "三项增长驱动", cards: [{ title: "产品", body: "关键流程缩短，激活率提升。" }, { title: "渠道", body: "伙伴渠道贡献更多高质量线索。" }, { title: "客户成功", body: "行业化运营提高续费与扩容。" }] },
  { layout: "stats", title: "关键经营指标", stats: [{ value: "+18%", label: "收入增长", detail: "高于年初目标 3 个百分点" }, { value: "92%", label: "续费率" }, { value: "-12%", label: "获客成本" }] },
  { layout: "comparison", title: "增长模式正在切换", left: { title: "过去", items: ["依赖新增客户", "项目交付为主", "渠道结构单一"] }, right: { title: "现在", items: ["续费与扩容并重", "标准产品驱动", "伙伴渠道协同"] } },
  { layout: "process", title: "下一阶段推进路径", steps: [{ title: "聚焦", body: "确认重点行业" }, { title: "验证", body: "跑通标杆客户" }, { title: "复制", body: "沉淀标准打法" }, { title: "放大", body: "伙伴规模复制" }] },
  { layout: "table", title: "季度行动计划", columns: ["事项", "负责人", "时间", "目标"], rows: [["行业方案", "产品", "Q1", "完成 3 套"], ["标杆客户", "销售", "Q2", "落地 5 家"], ["伙伴复制", "渠道", "Q3", "覆盖 20 家"]] },
  { layout: "summary", title: "结论与下一步", takeaway: "保持增长质量，集中资源打透重点行业。", actions: ["两周内确定重点行业", "一个月完成标杆客户清单", "季度末复盘复制效率"] },
];

test("generates all ten v2 layouts with editable Chinese text, notes, and unique shape ids", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "presentation-generator-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { version: 2, template: "executive", outputName: "经营复盘.pptx", slides: v2Slides };
  const archive = await readFile(await generatePresentation(spec, root, spec.outputName));
  const files = unzipStore(archive);
  assertClosedPackage(files);
  assert.equal([...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 10);
  for (const [name, source] of files) if (name.endsWith(".xml") || name.endsWith(".rels")) assertValidXml(source, name);
  for (let index = 0; index < v2Slides.length; index += 1) {
    const source = files.get(`ppt/slides/slide${index + 1}.xml`);
    assert.match(source, /lang="zh-CN"/);
    assert.match(source, /<a:ea typeface="Microsoft YaHei"/);
    const ids = [...source.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `slide ${index + 1} has duplicate shape ids`);
  }
  assert.match(files.get("docProps/core.xml"), /jugglework-template:executive:v2/);
  assert.match(files.get("ppt/theme/theme1.xml"), /<a:ea typeface="Microsoft YaHei"/);
  assert.match(files.get("ppt/notesSlides/notesSlide1.xml"), /开场先讲结论/);
  assert.match(files.get("ppt/slides/_rels/slide1.xml.rels"), /notesSlides\/notesSlide1.xml/);
  assert.match(files.get("ppt\/presentation.xml") ?? files.get("ppt/presentation.xml"), /notesMasterId/);
  assert.match(files.get("ppt/presentation.xml"), /<p:sldSz cx="12192000" cy="6858000"/);
  assert.match(files.get("ppt/notesMasters/notesMaster1.xml"), /<p:ph type="body" idx="1"/);
  assert.match(files.get("ppt/notesSlides/notesSlide1.xml"), /<a:xfrm>/);
});

test("strictly validates v2 layout fields and rejects content that cannot fit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "presentation-overflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = { version: 2, template: "minimal", outputName: "deck.pptx" };
  assert.throws(() => validateSpecification({ ...root, slides: [{ layout: "cover", title: "x", bullets: ["no"] }] }), /unsupported field bullets/);
  assert.throws(() => validateSpecification({ ...root, slides: [{ layout: "table", title: "x", columns: ["a", "b"], rows: [["only one"]] }] }), /must contain 2 cells/);
  const tooLong = "很长内容啊".repeat(52);
  const spec = validateSpecification({ ...root, slides: [{ layout: "cards", title: "x", cards: [
    { title: "卡片一", body: tooLong }, { title: "卡片二", body: "简短内容" },
    { title: "卡片三", body: "简短内容" }, { title: "卡片四", body: "简短内容" },
  ] }] });
  await assert.rejects(() => generatePresentation(spec, directory, "deck.pptx"), /slides\[0\]\.cards\[0\]\.body does not fit at 14pt/);
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => validateSpecification({ ...root, slides: [{ layout: "stats", title: "x", stats: [{ value: "1", label: "x", detail: 0 }] }] }), /detail must be a string/);
  assert.throws(() => validateSpecification({ ...root, slides: [{ layout: "process", title: "x", steps: [{ title: "a", body: false }, { title: "b" }] }] }), /body must be a string/);

  const narrow = validateSpecification({ ...root, slides: [{ layout: "process", title: "x", steps: Array.from({ length: 6 }, (_, index) => ({ title: index === 0 ? "非常狭窄的流程步骤标题需要被可靠拒绝而不是静默溢出到相邻步骤区域" : `步骤${index + 1}` })) }] });
  await assert.rejects(() => generatePresentation(narrow, directory, "deck.pptx"), /steps\[0\]\.title does not fit/);
  assert.deepEqual(await readdir(directory), []);
});

test("preserves explicit line breaks and the historical v1 acceptance range", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "presentation-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const v1 = { version: 1, template: "minimal", outputName: "legacy.pptx", slides: [{ title: "Legacy", bullets: ["中".repeat(500)] }] };
  await generatePresentation(v1, directory, v1.outputName);
  const v2 = { version: 2, template: "minimal", outputName: "newline.pptx", slides: [{ layout: "cover", title: "第一行\n第二行", subtitle: "明确换行" }] };
  const files = unzipStore(await readFile(await generatePresentation(v2, directory, v2.outputName)));
  assert.match(files.get("ppt/slides/slide1.xml"), /<a:t>第一行<\/a:t><\/a:r><a:br\/><a:r>/);
  assert.match(files.get("ppt/slides/slide1.xml"), /<a:t>第二行<\/a:t>/);
});

test("produces deterministic package bytes for identical content", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "presentation-deterministic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = { version: 2, template: "editorial", slides: [{ layout: "cover", title: "相同输入", subtitle: "得到相同字节" }] };
  const first = await readFile(await generatePresentation({ ...base, outputName: "one.pptx" }, directory, "one.pptx"));
  const second = await readFile(await generatePresentation({ ...base, outputName: "two.pptx" }, directory, "two.pptx"));
  assert.deepEqual(first, second);
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
