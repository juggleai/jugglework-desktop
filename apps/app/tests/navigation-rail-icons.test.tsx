/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatRailIcon, ContactsRailIcon } from "../src/react-app/design-system/navigation-rail-icons";

test("chat keeps three visible dots before and after selection", () => {
  for (const active of [false, true]) {
    const svg = renderToStaticMarkup(<ChatRailIcon active={active} />);
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain(`<g fill="${active ? "var(--dls-active)" : "currentColor"}" stroke="none"`);
  }
});

test("selected contacts retain a contrasting head and unfilled shoulder line", () => {
  const svg = renderToStaticMarkup(<ContactsRailIcon active />);
  expect(svg).toMatch(/<rect[^>]+fill="currentColor"/);
  expect(svg).toMatch(/<circle[^>]+fill="var\(--dls-active\)"/);
  expect(svg).toMatch(/<path[^>]+fill="none" stroke="var\(--dls-active\)"/);
});
