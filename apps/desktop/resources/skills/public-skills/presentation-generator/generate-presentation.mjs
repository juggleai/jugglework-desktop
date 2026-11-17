#!/usr/bin/env node
import { link, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EMU = 914400;
const W = 13.333333333333334;
const H = 7.5;
const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;
const TEMPLATES = Object.freeze({
  executive: {
    background: "0B1736", surface: "14264D", surface2: "1D3566", title: "FFFFFF", body: "D9E3F5",
    muted: "9FB0CF", accent: "50D5B7", accent2: "F5B942", latin: "Arial", eastAsia: "Microsoft YaHei",
  },
  editorial: {
    background: "F5EFE3", surface: "FFFFFF", surface2: "EADFCC", title: "2A2118", body: "55493C",
    muted: "8A7765", accent: "C85A3A", accent2: "2F6F6D", latin: "Georgia", eastAsia: "Microsoft YaHei",
  },
  minimal: {
    background: "FFFFFF", surface: "F4F7FB", surface2: "E8EEF8", title: "172033", body: "4B5565",
    muted: "7C8798", accent: "356AE6", accent2: "14A38B", latin: "Arial", eastAsia: "Microsoft YaHei",
  },
});
const LAYOUTS = new Set(["cover", "agenda", "section", "bullets", "cards", "stats", "comparison", "process", "table", "summary"]);
const encoder = new TextEncoder();

function fail(message) { throw new Error(`Invalid presentation specification: ${message}`); }
function hasInvalidXmlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9 || code === 0xa || code === 0xd) continue;
    if (code < 0x20 || code === 0x7f || code === 0xfffe || code === 0xffff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function safeText(value, field, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max || hasInvalidXmlCharacter(result)) fail(`${field} is empty, exceeds ${max} characters, or contains invalid XML characters`);
  return result;
}
function strictObject(value, field, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${field} contains unsupported field ${unknown}`);
  return value;
}
function textList(value, field, { min = 1, max = 8, itemMax = 240 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} must contain ${min}-${max} entries`);
  return value.map((item, index) => safeText(item, `${field}[${index}]`, itemMax));
}
function objectList(value, field, { min = 1, max = 6, allowed, normalize }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} must contain ${min}-${max} entries`);
  return value.map((item, index) => normalize(strictObject(item, `${field}[${index}]`, allowed), `${field}[${index}]`));
}

function validateV1(value) {
  const slides = value.slides.map((raw, index) => {
    const slide = strictObject(raw, `slides[${index}]`, new Set(["title", "subtitle", "bullets"]));
    const subtitle = safeText(slide.subtitle, `slides[${index}].subtitle`, 500, true);
    const bullets = slide.bullets === undefined ? [] : textList(slide.bullets, `slides[${index}].bullets`, { min: 0, max: 12, itemMax: 500 });
    return { title: safeText(slide.title, `slides[${index}].title`, 200), ...(subtitle ? { subtitle } : {}), ...(bullets.length ? { bullets } : {}) };
  });
  return { version: 1, template: value.template, outputName: value.outputName, slides };
}

const common = new Set(["layout", "title", "notes"]);
const fields = (...extra) => new Set([...common, ...extra]);
function normalizeV2Slide(raw, index) {
  const prefix = `slides[${index}]`;
  const probe = strictObject(raw, prefix, new Set([...common, "subtitle", "kicker", "items", "sectionNumber", "takeaway", "bullets", "cards", "stats", "left", "right", "steps", "columns", "rows", "actions"]));
  if (!LAYOUTS.has(probe.layout)) fail(`${prefix}.layout is invalid`);
  const layout = probe.layout;
  const allowedByLayout = {
    cover: fields("subtitle", "kicker"), agenda: fields("items"), section: fields("subtitle", "sectionNumber"),
    bullets: fields("takeaway", "bullets"), cards: fields("cards"), stats: fields("stats"),
    comparison: fields("left", "right"), process: fields("steps"), table: fields("columns", "rows"),
    summary: fields("takeaway", "actions"),
  }[layout];
  strictObject(raw, prefix, allowedByLayout);
  const base = { layout, title: safeText(probe.title, `${prefix}.title`, 160) };
  const notes = safeText(probe.notes, `${prefix}.notes`, 4000, true);
  if (notes) base.notes = notes;
  if (layout === "cover") {
    base.subtitle = safeText(probe.subtitle, `${prefix}.subtitle`, 360, true);
    base.kicker = safeText(probe.kicker, `${prefix}.kicker`, 80, true);
  } else if (layout === "agenda") base.items = textList(probe.items, `${prefix}.items`, { max: 8, itemMax: 100 });
  else if (layout === "section") {
    base.subtitle = safeText(probe.subtitle, `${prefix}.subtitle`, 320, true);
    base.sectionNumber = safeText(probe.sectionNumber, `${prefix}.sectionNumber`, 12, true);
  } else if (layout === "bullets") {
    base.takeaway = safeText(probe.takeaway, `${prefix}.takeaway`, 240, true);
    base.bullets = textList(probe.bullets, `${prefix}.bullets`, { max: 7, itemMax: 220 });
  } else if (layout === "cards") base.cards = objectList(probe.cards, `${prefix}.cards`, {
    max: 4, allowed: new Set(["title", "body"]), normalize: (item, field) => ({ title: safeText(item.title, `${field}.title`, 80), body: safeText(item.body, `${field}.body`, 260) }),
  });
  else if (layout === "stats") base.stats = objectList(probe.stats, `${prefix}.stats`, {
    max: 4, allowed: new Set(["value", "label", "detail"]), normalize: (item, field) => ({ value: safeText(item.value, `${field}.value`, 30), label: safeText(item.label, `${field}.label`, 80), ...(item.detail !== undefined ? { detail: safeText(item.detail, `${field}.detail`, 160, true) } : {}) }),
  });
  else if (layout === "comparison") {
    const side = (item, field) => { strictObject(item, field, new Set(["title", "items"])); return { title: safeText(item.title, `${field}.title`, 80), items: textList(item.items, `${field}.items`, { max: 6, itemMax: 150 }) }; };
    base.left = side(probe.left, `${prefix}.left`); base.right = side(probe.right, `${prefix}.right`);
  } else if (layout === "process") base.steps = objectList(probe.steps, `${prefix}.steps`, {
    min: 2, max: 6, allowed: new Set(["title", "body"]), normalize: (item, field) => ({ title: safeText(item.title, `${field}.title`, 70), ...(item.body !== undefined ? { body: safeText(item.body, `${field}.body`, 150, true) } : {}) }),
  });
  else if (layout === "table") {
    base.columns = textList(probe.columns, `${prefix}.columns`, { min: 2, max: 6, itemMax: 60 });
    if (!Array.isArray(probe.rows) || probe.rows.length < 1 || probe.rows.length > 8) fail(`${prefix}.rows must contain 1-8 entries`);
    base.rows = probe.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== base.columns.length) fail(`${prefix}.rows[${rowIndex}] must contain ${base.columns.length} cells`);
      return row.map((cell, cellIndex) => safeText(cell, `${prefix}.rows[${rowIndex}][${cellIndex}]`, 100));
    });
  } else if (layout === "summary") {
    base.takeaway = safeText(probe.takeaway, `${prefix}.takeaway`, 300);
    base.actions = textList(probe.actions, `${prefix}.actions`, { max: 5, itemMax: 160 });
  }
  return base;
}

export function validateSpecification(value) {
  strictObject(value, "root", new Set(["version", "template", "outputName", "slides"]));
  if (value.version !== 1 && value.version !== 2) fail("version must be 1 or 2");
  if (!Object.hasOwn(TEMPLATES, value.template)) fail("template must be executive, editorial, or minimal");
  const outputName = safeText(value.outputName, "outputName", 120);
  const stem = outputName.replace(/\.pptx$/i, "");
  if (!/^[^/\\<>:"|?*]+\.pptx$/i.test(outputName) || !stem || stem === "." || stem === ".." || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) fail("outputName must be a safe cross-platform .pptx filename");
  if (!Array.isArray(value.slides) || value.slides.length < 1 || value.slides.length > 30) fail("slides must contain 1-30 entries");
  const root = { ...value, outputName };
  return value.version === 1 ? validateV1(root) : { version: 2, template: value.template, outputName, slides: value.slides.map(normalizeV2Slide) };
}

function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
const emu = (value) => Math.round(value * EMU);
function weighted(value) { return [...String(value)].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : 0.58), 0); }
function fitSize(value, { field, width, height, preferred, minimum = 14, maxLines, paragraphCount = 1 }) {
  for (let size = preferred; size >= minimum; size -= 1) {
    const charsPerLine = Math.max(1, width * 72 / (size * 0.62));
    const heightLines = Math.max(1, Math.floor(height * 72 / (size * 1.3)));
    const availableLines = maxLines === undefined ? heightLines : Math.min(maxLines, heightLines);
    const wrappedLines = String(value).split(/\r\n?|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(weighted(line) / charsPerLine)), 0);
    const requiredLines = wrappedLines + Math.max(0, paragraphCount - 1);
    if (requiredLines <= availableLines) return size;
  }
  fail(`${field} does not fit at ${minimum}pt; shorten this content`);
}
function runs(text, size, color, theme, { bold = false } = {}) {
  const properties = `<a:rPr lang="zh-CN" altLang="en-US" sz="${size * 100}"${bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${xml(theme.latin)}"/><a:ea typeface="${xml(theme.eastAsia)}"/></a:rPr>`;
  const content = String(text).replaceAll("\t", "    ").split(/\r\n?|\n/).map((line) => {
    const preserve = /^\s|\s$| {2,}/.test(line) ? ' xml:space="preserve"' : "";
    return `<a:r>${properties}<a:t${preserve}>${xml(line)}</a:t></a:r>`;
  }).join("<a:br/>");
  return `${content}<a:endParaRPr lang="zh-CN" altLang="en-US" sz="${size * 100}"><a:latin typeface="${xml(theme.latin)}"/><a:ea typeface="${xml(theme.eastAsia)}"/></a:endParaRPr>`;
}
function shape(state, { name, text = "", x, y, w, h, size = 18, color, fill, line, radius = false, bold = false, align = "l", valign = "t", margin = 0.12, paragraphs, bullet = false }) {
  const id = state.id++;
  const values = paragraphs ?? [text];
  const ps = values.map((value) => `<a:p>${bullet
    ? `<a:pPr algn="${align}" marL="274320" indent="-182880"><a:buChar char="&#8226;"/></a:pPr>`
    : `<a:pPr algn="${align}"/>`}${runs(value, size, color, state.theme, { bold })}</a:p>`).join("");
  const geometry = radius ? "roundRect" : "rect";
  const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "<a:noFill/>";
  const lineXml = line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>";
  state.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr><p:txBody><a:bodyPr wrap="square" anchor="${valign}" lIns="${emu(margin)}" rIns="${emu(margin)}" tIns="${emu(margin)}" bIns="${emu(margin)}"/><a:lstStyle/>${ps}</p:txBody></p:sp>`);
}
function title(state, slide, index) {
  const size = fitSize(slide.title, { field: `slides[${index}].title`, width: 11.5, height: 0.75, preferred: 30, minimum: 24, maxLines: 2 });
  shape(state, { name: "Title", text: slide.title, x: 0.8, y: 0.45, w: 11.5, h: 0.75, size, color: state.theme.title, bold: true, margin: 0 });
  shape(state, { name: "Title accent", x: 0.8, y: 1.25, w: 0.75, h: 0.06, fill: state.theme.accent, color: state.theme.accent, margin: 0 });
}
function bulletBlock(state, items, index, field, { x, y, w, h, color, fill, enforceFit = true } = {}) {
  const joined = items.join(" ");
  const size = enforceFit ? fitSize(joined, { field: `slides[${index}].${field}`, width: w - 0.75, height: h - 0.4, preferred: 20, minimum: 14, paragraphCount: items.length }) : 20;
  shape(state, { name: field, paragraphs: items, x, y, w, h, size, color, fill, bullet: true, margin: 0.2 });
}
function fittedShape(state, value, field, options, fit = {}) {
  const margin = options.margin ?? 0.12;
  const size = fitSize(value, {
    field,
    width: Math.max(0.1, options.w - margin * 2),
    height: Math.max(0.1, options.h - margin * 2),
    preferred: options.size,
    minimum: fit.minimum ?? 14,
    ...(fit.maxLines ? { maxLines: fit.maxLines } : {}),
  });
  shape(state, { ...options, text: value, size });
}
function renderV1(slide, theme, index) {
  const state = { id: 2, theme, shapes: [] };
  shape(state, { name: "Accent", x: 0.72, y: index === 0 ? 1.1 : 0.65, w: 0.12, h: 0.85, fill: theme.accent, color: theme.accent });
  shape(state, { name: "Editable title", text: slide.title, x: 1.05, y: index === 0 ? 1.1 : 0.65, w: 10.8, h: 1.15, size: index === 0 ? 30 : 24, color: theme.title, bold: true });
  if (slide.subtitle) shape(state, { name: "Editable subtitle", text: slide.subtitle, x: 1.05, y: index === 0 ? 2.45 : 1.6, w: 10.7, h: 0.65, size: 15, color: theme.body });
  // v1 keeps its historical acceptance/rendering behavior; strict capacity checks apply to v2.
  if (slide.bullets?.length) bulletBlock(state, slide.bullets, index, "bullets", { x: 1.05, y: index === 0 ? 3.25 : 2.3, w: 10.7, h: 3.2, color: theme.body, enforceFit: false });
  return state.shapes.join("");
}
function renderV2(slide, theme, index) {
  const state = { id: 2, theme, shapes: [] };
  const cardFill = theme.surface;
  if (slide.layout === "cover") {
    shape(state, { name: "Cover accent", x: 0, y: 0, w: 0.28, h: H, fill: theme.accent, color: theme.accent });
    if (slide.kicker) fittedShape(state, slide.kicker.toUpperCase(), `slides[${index}].kicker`, { name: "Kicker", x: 1.0, y: 1.25, w: 10.5, h: 0.4, size: 13, color: theme.accent, bold: true, margin: 0 }, { minimum: 11, maxLines: 1 });
    const size = fitSize(slide.title, { field: `slides[${index}].title`, width: 10.8, height: 1.9, preferred: 42, minimum: 28, maxLines: 3 });
    shape(state, { name: "Cover title", text: slide.title, x: 1.0, y: 1.8, w: 10.8, h: 1.9, size, color: theme.title, bold: true, margin: 0, valign: "ctr" });
    if (slide.subtitle) fittedShape(state, slide.subtitle, `slides[${index}].subtitle`, { name: "Cover subtitle", x: 1.0, y: 4.1, w: 9.6, h: 1.0, size: 19, color: theme.body, margin: 0 }, { minimum: 14, maxLines: 3 });
    shape(state, { name: "Cover marker", text: String(index + 1).padStart(2, "0"), x: 11.4, y: 6.15, w: 0.9, h: 0.55, size: 14, color: theme.muted, align: "r", margin: 0 });
  } else if (slide.layout === "section") {
    shape(state, { name: "Section panel", x: 0, y: 0, w: 4.1, h: H, fill: theme.accent, color: theme.accent });
    shape(state, { name: "Section number", text: slide.sectionNumber ?? String(index).padStart(2, "0"), x: 0.8, y: 1.4, w: 2.5, h: 1.3, size: 50, color: theme.background, bold: true, margin: 0 });
    fittedShape(state, slide.title, `slides[${index}].title`, { name: "Section title", x: 4.8, y: 2.2, w: 7.5, h: 1.5, size: 34, color: theme.title, bold: true, margin: 0, valign: "ctr" }, { minimum: 24, maxLines: 3 });
    if (slide.subtitle) fittedShape(state, slide.subtitle, `slides[${index}].subtitle`, { name: "Section subtitle", x: 4.8, y: 4.0, w: 7.0, h: 1.1, size: 18, color: theme.body, margin: 0 }, { minimum: 14, maxLines: 3 });
  } else {
    title(state, slide, index);
    if (slide.layout === "agenda") {
      slide.items.forEach((item, itemIndex) => {
        const y = 1.65 + itemIndex * (4.85 / slide.items.length);
        shape(state, { name: `Agenda ${itemIndex + 1}`, text: String(itemIndex + 1).padStart(2, "0"), x: 1.0, y, w: 0.7, h: 0.45, size: 14, color: theme.accent, bold: true, margin: 0 });
        fittedShape(state, item, `slides[${index}].items[${itemIndex}]`, { name: `Agenda item ${itemIndex + 1}`, x: 1.9, y: y - 0.04, w: 9.8, h: 0.55, size: 20, color: theme.body, margin: 0 }, { minimum: 14, maxLines: 2 });
        shape(state, { name: `Agenda line ${itemIndex + 1}`, x: 1.9, y: y + 0.56, w: 9.7, h: 0.015, fill: theme.surface2, color: theme.surface2, margin: 0 });
      });
    } else if (slide.layout === "bullets") {
      if (slide.takeaway) fittedShape(state, slide.takeaway, `slides[${index}].takeaway`, { name: "Takeaway", x: 0.9, y: 1.55, w: 11.4, h: 0.9, size: 21, color: theme.title, fill: theme.surface2, bold: true, radius: true, valign: "ctr", margin: 0.25 }, { minimum: 14, maxLines: 2 });
      bulletBlock(state, slide.bullets, index, "bullets", { x: 1.0, y: slide.takeaway ? 2.75 : 1.75, w: 11.0, h: slide.takeaway ? 3.7 : 4.75, color: theme.body });
    } else if (slide.layout === "cards") {
      const count = slide.cards.length; const gap = 0.25; const width = (11.5 - gap * (count - 1)) / count;
      slide.cards.forEach((card, cardIndex) => {
        const x = 0.9 + cardIndex * (width + gap);
        shape(state, { name: `Card ${cardIndex + 1}`, x, y: 1.65, w: width, h: 4.85, fill: cardFill, line: theme.surface2, color: theme.body, radius: true });
        shape(state, { name: `Card number ${cardIndex + 1}`, text: String(cardIndex + 1).padStart(2, "0"), x: x + 0.25, y: 1.95, w: width - 0.5, h: 0.4, size: 13, color: theme.accent, bold: true, margin: 0 });
        fittedShape(state, card.title, `slides[${index}].cards[${cardIndex}].title`, { name: `Card title ${cardIndex + 1}`, x: x + 0.25, y: 2.55, w: width - 0.5, h: 0.75, size: 20, color: theme.title, bold: true, margin: 0 }, { minimum: 14, maxLines: 3 });
        const size = fitSize(card.body, { field: `slides[${index}].cards[${cardIndex}].body`, width: width - 0.5, height: 2.6, preferred: 16, minimum: 14 });
        shape(state, { name: `Card body ${cardIndex + 1}`, text: card.body, x: x + 0.25, y: 3.45, w: width - 0.5, h: 2.45, size, color: theme.body, margin: 0 });
      });
    } else if (slide.layout === "stats") {
      const count = slide.stats.length; const width = 11.5 / count;
      slide.stats.forEach((stat, statIndex) => {
        const x = 0.9 + statIndex * width;
        fittedShape(state, stat.value, `slides[${index}].stats[${statIndex}].value`, { name: `Stat value ${statIndex + 1}`, x: x + 0.1, y: 2.0, w: width - 0.2, h: 1.2, size: 38, color: statIndex % 2 ? theme.accent2 : theme.accent, bold: true, align: "ctr", valign: "ctr", margin: 0 }, { minimum: 22, maxLines: 2 });
        fittedShape(state, stat.label, `slides[${index}].stats[${statIndex}].label`, { name: `Stat label ${statIndex + 1}`, x: x + 0.15, y: 3.35, w: width - 0.3, h: 0.7, size: 18, color: theme.title, bold: true, align: "ctr", margin: 0 }, { minimum: 14, maxLines: 2 });
        if (stat.detail) fittedShape(state, stat.detail, `slides[${index}].stats[${statIndex}].detail`, { name: `Stat detail ${statIndex + 1}`, x: x + 0.2, y: 4.25, w: width - 0.4, h: 1.4, size: 14, color: theme.body, align: "ctr", margin: 0 }, { minimum: 14, maxLines: 4 });
      });
    } else if (slide.layout === "comparison") {
      [slide.left, slide.right].forEach((side, sideIndex) => {
        const x = sideIndex ? 6.85 : 0.85; const fill = sideIndex ? theme.surface2 : theme.surface;
        shape(state, { name: sideIndex ? "Right panel" : "Left panel", x, y: 1.6, w: 5.65, h: 4.95, fill, line: theme.surface2, color: theme.body, radius: true });
        fittedShape(state, side.title, `slides[${index}].${sideIndex ? "right" : "left"}.title`, { name: `${sideIndex ? "Right" : "Left"} title`, x: x + 0.35, y: 1.95, w: 4.95, h: 0.7, size: 22, color: theme.title, bold: true, margin: 0 }, { minimum: 16, maxLines: 2 });
        bulletBlock(state, side.items, index, sideIndex ? "right.items" : "left.items", { x: x + 0.25, y: 2.85, w: 5.0, h: 3.2, color: theme.body });
      });
    } else if (slide.layout === "process") {
      const count = slide.steps.length; const width = 11.5 / count;
      slide.steps.forEach((step, stepIndex) => {
        const x = 0.9 + stepIndex * width;
        shape(state, { name: `Step marker ${stepIndex + 1}`, text: String(stepIndex + 1), x: x + (width - 0.7) / 2, y: 2.0, w: 0.7, h: 0.7, size: 18, color: theme.background, fill: theme.accent, bold: true, align: "ctr", valign: "ctr", radius: true, margin: 0 });
        if (stepIndex < count - 1) shape(state, { name: `Step line ${stepIndex + 1}`, x: x + width / 2 + 0.35, y: 2.33, w: width - 0.7, h: 0.05, fill: theme.surface2, color: theme.surface2 });
        fittedShape(state, step.title, `slides[${index}].steps[${stepIndex}].title`, { name: `Step title ${stepIndex + 1}`, x: x + 0.1, y: 3.05, w: width - 0.2, h: 0.75, size: 18, color: theme.title, bold: true, align: "ctr", margin: 0 }, { minimum: 14, maxLines: 3 });
        if (step.body) fittedShape(state, step.body, `slides[${index}].steps[${stepIndex}].body`, { name: `Step body ${stepIndex + 1}`, x: x + 0.15, y: 4.0, w: width - 0.3, h: 1.6, size: 14, color: theme.body, align: "ctr", margin: 0 }, { minimum: 14, maxLines: 5 });
      });
    } else if (slide.layout === "table") {
      const rows = [slide.columns, ...slide.rows]; const colW = 11.55 / slide.columns.length; const rowH = Math.min(0.65, 4.9 / rows.length);
      rows.forEach((row, rowIndex) => row.forEach((cell, colIndex) => {
        const isHeader = rowIndex === 0;
        const size = fitSize(cell, { field: `slides[${index}].${isHeader ? `columns[${colIndex}]` : `rows[${rowIndex - 1}][${colIndex}]`}`, width: colW - 0.24, height: rowH - 0.24, preferred: isHeader ? 15 : 14, minimum: 14 });
        shape(state, { name: `Cell ${rowIndex + 1}-${colIndex + 1}`, text: cell, x: 0.88 + colIndex * colW, y: 1.6 + rowIndex * rowH, w: colW, h: rowH, size, color: isHeader ? theme.background : theme.body, fill: isHeader ? theme.accent : (rowIndex % 2 ? theme.surface : theme.surface2), line: theme.background, bold: isHeader, valign: "ctr", margin: 0.12 });
      }));
    } else if (slide.layout === "summary") {
      shape(state, { name: "Summary takeaway", text: slide.takeaway, x: 0.9, y: 1.65, w: 7.4, h: 3.9, size: fitSize(slide.takeaway, { field: `slides[${index}].takeaway`, width: 7, height: 3.4, preferred: 30, minimum: 20 }), color: theme.title, fill: theme.surface, bold: true, radius: true, valign: "ctr", margin: 0.4 });
      shape(state, { name: "Actions heading", text: "NEXT STEPS", x: 8.75, y: 1.8, w: 3.5, h: 0.45, size: 13, color: theme.accent, bold: true, margin: 0 });
      slide.actions.forEach((action, actionIndex) => fittedShape(state, `${actionIndex + 1}.  ${action}`, `slides[${index}].actions[${actionIndex}]`, { name: `Action ${actionIndex + 1}`, x: 8.75, y: 2.55 + actionIndex * 0.82, w: 3.55, h: 0.65, size: 15, color: theme.body, margin: 0 }, { minimum: 14, maxLines: 2 }));
    }
  }
  return state.shapes.join("");
}
function slideXml(slide, theme, index, version) {
  const content = version === 1 ? renderV1(slide, theme, index) : renderV2(slide, theme, index);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Slide ${index + 1}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function noteXml(note, index, theme) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder ${index + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4572000"/><a:ext cx="5486400" cy="3657600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p>${runs(note, 12, theme.body, theme)}</a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function buildParts(spec) {
  const theme = TEMPLATES[spec.template];
  const notes = spec.slides.map((slide, index) => slide.notes ? index : -1).filter((index) => index >= 0);
  const slideOverrides = spec.slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const noteOverrides = notes.map((index) => `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("");
  const notesMasterOverride = notes.length ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' : "";
  const slideIds = spec.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const slideRels = spec.slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  const trailing = spec.slides.length + 2; const notesMasterRel = notes.length ? `<Relationship Id="rId${trailing + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` : "";
  const files = new Map([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideOverrides}${noteOverrides}${notesMasterOverride}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(spec.slides[0].title)}</dc:title><dc:creator>北数Work</dc:creator><cp:keywords>jugglework-template:${spec.template}:v${spec.version}</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`],
    ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>北数Work Presentation Generator</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${spec.slides.length}</Slides><Notes>${notes.length}</Notes><HiddenSlides>0</HiddenSlides></Properties>`],
    ["ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notes.length ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${trailing + 3}"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels}<Relationship Id="rId${trailing}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${trailing + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${trailing + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>${notesMasterRel}</Relationships>`],
    ["ppt/presProps.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'],
    ["ppt/viewProps.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr/><p:slideViewPr/><p:notesTextViewPr/></p:viewPr>'],
    ["ppt/tableStyles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>'],
    ["ppt/theme/theme1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="北数Work ${xml(spec.template)} v${spec.version}"><a:themeElements><a:clrScheme name="北数Work"><a:dk1><a:srgbClr val="${theme.title}"/></a:dk1><a:lt1><a:srgbClr val="${theme.background}"/></a:lt1><a:dk2><a:srgbClr val="${theme.body}"/></a:dk2><a:lt2><a:srgbClr val="${theme.surface}"/></a:lt2><a:accent1><a:srgbClr val="${theme.accent}"/></a:accent1><a:accent2><a:srgbClr val="${theme.accent2}"/></a:accent2><a:accent3><a:srgbClr val="${theme.surface}"/></a:accent3><a:accent4><a:srgbClr val="${theme.surface2}"/></a:accent4><a:accent5><a:srgbClr val="${theme.muted}"/></a:accent5><a:accent6><a:srgbClr val="${theme.body}"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="北数Work"><a:majorFont><a:latin typeface="${xml(theme.latin)}"/><a:ea typeface="${xml(theme.eastAsia)}"/><a:cs typeface="${xml(theme.latin)}"/></a:majorFont><a:minorFont><a:latin typeface="${xml(theme.latin)}"/><a:ea typeface="${xml(theme.eastAsia)}"/><a:cs typeface="${xml(theme.latin)}"/></a:minorFont></a:fontScheme><a:fmtScheme name="北数Work"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="20000"/><a:satMod val="300000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`],
    ["ppt/slideMasters/slideMaster1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt1" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk1"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>'],
    ["ppt/slideLayouts/slideLayout1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'],
  ]);
  spec.slides.forEach((slide, index) => {
    files.set(`ppt/slides/slide${index + 1}.xml`, slideXml(slide, theme, index, spec.version));
    const noteRel = slide.notes ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/>` : "";
    files.set(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${noteRel}</Relationships>`);
    if (slide.notes) {
      files.set(`ppt/notesSlides/notesSlide${index + 1}.xml`, noteXml(slide.notes, index, theme));
      files.set(`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${index + 1}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/></Relationships>`);
    }
  });
  if (notes.length) {
    files.set("ppt/notesMasters/notesMaster1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Body Placeholder"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4572000"/><a:ext cx="5486400" cy="3657600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt1" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk1"/><p:notesStyle/></p:notesMaster>');
    files.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
  }
  return files;
}

const crcTable = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1); return crc >>> 0; });
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function u16(value) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; }
function zipStore(files) {
  const local = []; const central = []; let offset = 0;
  for (const [name, source] of [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const nameBytes = encoder.encode(name); const data = encoder.encode(source); const checksum = crc32(data);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
    local.push(header, data);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    offset += header.length + data.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([...local, directory, u32(0x06054b50), u16(0), u16(0), u16(files.size), u16(files.size), u32(directory.length), u32(offset), u16(0)]);
}
function validatePackage(files, spec) {
  const required = ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "docProps/app.xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/theme/theme1.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml"];
  for (const name of required) if (!files.has(name)) throw new Error(`Generated package is missing ${name}`);
  spec.slides.forEach((_, index) => { const name = `ppt/slides/slide${index + 1}.xml`; const source = files.get(name); if (!source?.includes("<p:sp>") || !source.includes("<a:t>")) throw new Error(`${name} does not contain editable text shapes`); });
  if (!files.get("docProps/core.xml")?.includes(`jugglework-template:${spec.template}:v${spec.version}`)) throw new Error("Generated package lost its template marker");
}
export async function generatePresentation(rawSpec, outputDirectory, requestedOutput) {
  const spec = validateSpecification(rawSpec);
  if (requestedOutput !== spec.outputName) fail("--output must match outputName");
  const files = buildParts(spec); validatePackage(files, spec); const archive = zipStore(files);
  if (archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt32LE(archive.length - 22) !== 0x06054b50) throw new Error("Generated ZIP failed structural validation");
  const outputPath = path.join(outputDirectory, spec.outputName);
  const temporaryPath = path.join(outputDirectory, `.${spec.outputName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, archive, { flag: "wx" });
    // Hard-link publication keeps the no-overwrite guarantee while making the visible result atomic.
    await link(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return outputPath;
}
function parseArgs(argv) { if (argv.length !== 4 || argv[0] !== "--spec-json" || argv[2] !== "--output") fail("expected --spec-json <json> --output <filename>"); let value; try { value = JSON.parse(argv[1]); } catch { fail("--spec-json must contain valid JSON"); } return { value, output: argv[3] }; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { value, output } = parseArgs(process.argv.slice(2)); const outputDirectory = process.env.JUGGLEWORK_ARTIFACT_DIR; if (!outputDirectory) throw new Error("JUGGLEWORK_ARTIFACT_DIR is required"); await generatePresentation(value, outputDirectory, output); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
