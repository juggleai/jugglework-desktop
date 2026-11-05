import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

const domainRoot = resolve(import.meta.dir, "../src/react-app/domains/calendar");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : extname(path).match(/^\.tsx?$/) ? [path] : [];
  });
}

function importsOf(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
  });
}

function resolveRelativeImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")].find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

describe("calendar domain import boundary", () => {
  const files = sourceFiles(domainRoot);

  test("does not import tasks, automations, session, or Agent modules", () => {
    const forbidden = /(?:^|\/)(?:tasks?|automations?|session|agents?)(?:\/|$)/i;
    const violations = files.flatMap((file) => importsOf(file).filter((specifier) => forbidden.test(specifier)).map((specifier) => `${relative(domainRoot, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  test("contains no relative module cycles", () => {
    const graph = new Map(files.map((file) => [file, importsOf(file).map((specifier) => resolveRelativeImport(file, specifier)).filter((target): target is string => Boolean(target) && target.startsWith(domainRoot))]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    const visit = (file: string, stack: string[]) => {
      if (visiting.has(file)) {
        cycles.push([...stack.slice(stack.indexOf(file)), file].map((item) => relative(domainRoot, item)).join(" -> "));
        return;
      }
      if (visited.has(file)) return;
      visiting.add(file);
      for (const target of graph.get(file) ?? []) visit(target, [...stack, file]);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
  });
});
