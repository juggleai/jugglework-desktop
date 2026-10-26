import { expect, test } from "bun:test";

const editor = await Bun.file(new URL("../src/react-app/domains/session/surface/composer/editor.tsx", import.meta.url)).text();
const composer = await Bun.file(new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url)).text();

test("compact editor gives caret and placeholder the same 40px box and 8px top inset", () => {
  expect(editor).toContain('"h-10 min-h-10 max-h-[112px]');
  expect(editor).toContain('px-2 py-2 text-[17px] leading-6');
  expect(editor).toContain('"pointer-events-none absolute left-2 top-2 text-[17px] leading-6');
  expect(composer).toContain("compact={props.compact}");
});
