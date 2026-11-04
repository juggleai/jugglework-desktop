const kinds = { doc: "docx", sheet: "xlsx", slide: "pptx", csv: "csv" };
export function acceptanceOptions(args) {
  let format, kind;
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split("=");
    if (["--kind", "--format"].includes(key)) {
      const value = inline ?? args[++i];
      if (key === "--kind") { if (!kinds[value]) throw new Error("Invalid --kind"); kind = value; }
      else { if (!Object.values(kinds).includes(value)) throw new Error("Invalid --format"); format = value; }
    } else if (["--ui-undo", "--ui-undo-toolbar", "--fail-required-resource", "--fail-unknown-resource", "--review-resources"].includes(key) && inline === undefined) flags.add(key);
    else throw new Error(`Unknown acceptance argument: ${key}`);
  }
  if (kind && format && kinds[kind] !== format) throw new Error("Conflicting --kind and --format");
  format ??= kinds[kind] ?? "csv";
  kind = format === "csv" ? "sheet" : Object.keys(kinds).find((key) => kinds[key] === format);
  if ((flags.has("--ui-undo") || flags.has("--ui-undo-toolbar")) && kind !== "sheet") throw new Error("UI undo currently supports sheet/csv only");
  return { format, kind, flags: [...flags] };
}
