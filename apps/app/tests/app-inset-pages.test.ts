import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("secondary app inset shells", () => {
  test("defines one shared rounded inset surface contract", () => {
    const source = read("react-app/shell/app-inset-surface.tsx");
    expect(source).toContain("mt-11");
    expect(source).toContain("mb-1.5 ml-1 mr-1.5");
    expect(source).toContain("rounded-[18px]");
    expect(source).toContain("border border-dls-border bg-background");
    expect(source).toContain("data-app-inset-surface");
  });

  test("places Automation, Review, Chat, and Contacts inside the shared surface", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const reviews = read("react-app/domains/reviews/review-page.tsx");
    const chat = read("react-app/shell/chat-page.tsx");
    for (const source of [automation, reviews, chat]) {
      expect(source).toContain("bg-dls-sidebar mac:titlebar-drag");
      expect(source).toContain("<AppInsetSurface");
    }
    expect(automation).toContain('testId="automation-inset-surface"');
    expect(reviews).toContain('testId="review-inset-surface"');
    expect(chat).toContain('testId="chat-inset-surface"');
    expect(chat).toContain("<JuggleChatApp");
  });

  test("joins the Settings navigation and content into one rounded surface", () => {
    const page = read("react-app/domains/settings/shell/settings-page.tsx");
    const shell = read("react-app/domains/settings/shell/settings-shell.tsx");
    expect(page).toContain("data-settings-list-surface");
    expect(page).toContain("mt-11");
    expect(page).toContain("rounded-l-[18px]");
    expect(page).toContain("border-r-0");
    expect(shell).toContain("data-settings-content-surface");
    expect(shell).toContain("mt-11");
    expect(shell).toContain("rounded-r-[18px]");
    expect(shell).toContain("border border-dls-border");
    expect(shell).not.toContain("border-l-0");
  });
});
