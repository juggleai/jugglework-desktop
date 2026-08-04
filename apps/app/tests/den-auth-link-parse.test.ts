import { expect, test } from "bun:test";

import {
  parseDenAuthDeepLink,
  parseManualDenAuthInput,
} from "../src/app/lib/jugglework-links";

const grant = "lYvkQa3NiACHVmARJ_pesQ0UmGlmjT-M";
const baseUrl = "https://work.juggle.im/jwork";

test("parses a normal desktop authorization link", () => {
  expect(
    parseManualDenAuthInput(
      `jugglework://den-auth?denBaseUrl=${encodeURIComponent(baseUrl)}&grant=${grant}`,
    ),
  ).toEqual({ grant, baseUrl });
});

test("repairs a JSON-escaped query delimiter in a pasted authorization link", () => {
  const escaped = `jugglework://den-auth?denBaseUrl=${encodeURIComponent(baseUrl)}\\u0026grant=${grant}`;
  expect(parseManualDenAuthInput(escaped)).toEqual({ grant, baseUrl });
  expect(parseDenAuthDeepLink(escaped)).toEqual({ grant, denBaseUrl: baseUrl });
});

test("accepts a raw opaque one-time grant", () => {
  expect(parseManualDenAuthInput(grant)).toEqual({ grant });
});

test("rejects browser login pages and unrelated or malformed input", () => {
  expect(
    parseManualDenAuthInput(
      "https://work.juggle.im/jwork/login?desktopAuth=1&desktopScheme=jugglework",
    ),
  ).toBeNull();
  expect(parseManualDenAuthInput("https://example.test/not-den-auth?grant=abc"))
    .toBeNull();
  expect(parseManualDenAuthInput("not a token"))
    .toBeNull();
  expect(parseManualDenAuthInput("too-short"))
    .toBeNull();
});
