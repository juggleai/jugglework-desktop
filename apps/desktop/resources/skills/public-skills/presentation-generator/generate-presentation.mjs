#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = Object.freeze({
  executive: { background: "0B1736", title: "FFFFFF", body: "D9E3F5", accent: "50D5B7", font: "Aptos Display" },
  editorial: { background: "F5EFE3", title: "2A2118", body: "55493C", accent: "C85A3A", font: "Georgia" },
  minimal: { background: "FFFFFF", title: "172033", body: "4B5565", accent: "356AE6", font: "Aptos" },
});

const encoder = new TextEncoder();
const requiredParts = [
  "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml",
  "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/theme/theme1.xml",
  "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml",
];

function fail(message) {
  throw new Error(`Invalid presentation specification: ${message}`);
}

function text(value, field, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const normalized = value.trim();
  if ((!optional && !normalized) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    fail(`${field} is empty or exceeds ${max} characters`);
  }
  return normalized;
}

export function validateSpecification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("root must be an object");
  if (value.version !== 1) fail("version must be 1");
  if (!Object.hasOwn(TEMPLATES, value.template)) fail("template must be executive, editorial, or minimal");
  const outputName = text(value.outputName, "outputName", 120);
  if (!/^[^/\\]+\.pptx$/i.test(outputName) || outputName === ".pptx" || outputName.includes("..")) fail("outputName must be a safe .pptx filename");
  if (!Array.isArray(value.slides) || value.slides.length < 1 || value.slides.length > 30) fail("slides must contain 1-30 entries");
  const slides = value.slides.map((slide, index) => {
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) fail(`slides[${index}] must be an object`);
    const allowed = new Set(["title", "subtitle", "bullets"]);
    if (Object.keys(slide).some((key) => !allowed.has(key))) fail(`slides[${index}] contains an unsupported field`);
    const subtitle = text(slide.subtitle, `slides[${index}].subtitle`, 500, true);
    if (slide.bullets !== undefined && (!Array.isArray(slide.bullets) || slide.bullets.length > 12)) fail(`slides[${index}].bullets must contain at most 12 entries`);
    const bullets = (slide.bullets ?? []).map((item, bulletIndex) => text(item, `slides[${index}].bullets[${bulletIndex}]`, 500));
    return { title: text(slide.title, `slides[${index}].title`, 200), ...(subtitle ? { subtitle } : {}), ...(bullets.length ? { bullets } : {}) };
  });
  return { version: 1, template: value.template, outputName, slides };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function shape(id, name, value, x, y, cx, cy, size, color, font, options = {}) {
  const paragraphs = Array.isArray(value) ? value : [value];
  const runs = paragraphs.map((line) => `<a:p>${options.bullets ? '<a:pPr lvl="0" marL="342900" indent="-228600"><a:buChar char="&#8226;"/></a:pPr>' : ""}<a:r><a:rPr lang="en-US" sz="${size}"${options.bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${xml(font)}"/></a:rPr><a:t>${xml(line)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${size}"/></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/>${runs}</p:txBody></p:sp>`;
}

function slideXml(slide, theme, index) {
  const titleY = index === 0 ? 1150000 : 720000;
  const titleSize = index === 0 ? 3000 : 2400;
  const content = slide.bullets?.length
    ? shape(5, "Editable bullets", slide.bullets, 1060000, index === 0 ? 3250000 : 2350000, 9800000, 3000000, 1800, theme.body, theme.font, { bullets: true })
    : "";
  const subtitle = slide.subtitle
    ? shape(4, "Editable subtitle", slide.subtitle, 1060000, index === 0 ? 2500000 : 1650000, 9800000, 700000, 1500, theme.body, theme.font)
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Slide ${index + 1}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="720000" y="${titleY - 140000}"/><a:ext cx="120000" cy="760000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${theme.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>${shape(3, "Editable title", slide.title, 1060000, titleY, 9800000, 1050000, titleSize, theme.title, theme.font, { bold: true })}${subtitle}${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function buildParts(spec) {
  const theme = TEMPLATES[spec.template];
  const slideOverrides = spec.slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const slideIds = spec.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const slideRels = spec.slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  const files = new Map([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideOverrides}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(spec.slides[0].title)}</dc:title><dc:creator>JuggleWork</dc:creator><cp:keywords>jugglework-template:${spec.template}:v1</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`],
    ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>JuggleWork Presentation Generator</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${spec.slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides></Properties>`],
    ["ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels}<Relationship Id="rId${spec.slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${spec.slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${spec.slides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>`],
    ["ppt/presProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`],
    ["ppt/viewProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr/><p:slideViewPr/><p:notesTextViewPr/><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`],
    ["ppt/tableStyles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
    ["ppt/theme/theme1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="JuggleWork ${xml(spec.template)} v1"><a:themeElements><a:clrScheme name="JuggleWork"><a:dk1><a:srgbClr val="${theme.title}"/></a:dk1><a:lt1><a:srgbClr val="${theme.background}"/></a:lt1><a:dk2><a:srgbClr val="${theme.body}"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="${theme.accent}"/></a:accent1><a:accent2><a:srgbClr val="6B7280"/></a:accent2><a:accent3><a:srgbClr val="94A3B8"/></a:accent3><a:accent4><a:srgbClr val="CBD5E1"/></a:accent4><a:accent5><a:srgbClr val="64748B"/></a:accent5><a:accent6><a:srgbClr val="334155"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="JuggleWork"><a:majorFont><a:latin typeface="${xml(theme.font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${xml(theme.font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="JuggleWork"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`],
    ["ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`],
    ["ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
  ]);
  spec.slides.forEach((slide, index) => {
    files.set(`ppt/slides/slide${index + 1}.xml`, slideXml(slide, theme, index));
    files.set(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
  });
  return files;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; }

function zipStore(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, source] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(source);
    const checksum = crc32(data);
    const localHeader = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
    local.push(localHeader, data);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    offset += localHeader.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.size), u16(files.size), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...local, directory, end]);
}

function validatePackage(files, spec) {
  for (const name of requiredParts) if (!files.has(name)) throw new Error(`Generated package is missing ${name}`);
  for (let index = 0; index < spec.slides.length; index += 1) {
    const name = `ppt/slides/slide${index + 1}.xml`;
    const slide = files.get(name);
    if (!slide?.includes("<p:sp>") || !slide.includes("<a:t>")) throw new Error(`${name} does not contain editable text shapes`);
    if (!files.has(`ppt/slides/_rels/slide${index + 1}.xml.rels`)) throw new Error(`${name} has no layout relationship`);
  }
  if (!files.get("docProps/core.xml")?.includes(`jugglework-template:${spec.template}:v1`)) throw new Error("Generated package lost its template marker");
}

export async function generatePresentation(rawSpec, outputDirectory, requestedOutput) {
  const spec = validateSpecification(rawSpec);
  if (requestedOutput !== spec.outputName) fail("--output must match outputName");
  const files = buildParts(spec);
  validatePackage(files, spec);
  const archive = zipStore(files);
  if (archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt32LE(archive.length - 22) !== 0x06054b50) throw new Error("Generated ZIP failed structural validation");
  const outputPath = path.join(outputDirectory, spec.outputName);
  await writeFile(outputPath, archive, { flag: "wx" });
  return outputPath;
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--spec-json" || argv[2] !== "--output") fail("expected --spec-json <json> --output <filename>");
  let value;
  try { value = JSON.parse(argv[1]); } catch { fail("--spec-json must contain valid JSON"); }
  return { value, output: argv[3] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { value, output } = parseArgs(process.argv.slice(2));
    const outputDirectory = process.env.JUGGLEWORK_ARTIFACT_DIR;
    if (!outputDirectory) throw new Error("JUGGLEWORK_ARTIFACT_DIR is required");
    await generatePresentation(value, outputDirectory, output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
