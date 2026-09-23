import { emitKeypressEvents, type Key } from "node:readline";
import { stdin } from "node:process";
import type { CliRenderer } from "./render.js";

export type ComposerChoice = { value: string; label: string; detail?: string };

export function filterComposerChoices(choices: ComposerChoice[], query: string): ComposerChoice[] {
  const needle = query.trim().toLowerCase();
  return choices.filter((choice) => !needle || `${choice.label} ${choice.detail ?? ""}`.toLowerCase().includes(needle));
}

export function moveComposerSelection(index: number, count: number, direction: number): number {
  return count ? (index + direction + count) % count : 0;
}

type ComposerOptions = {
  renderer: CliRenderer;
  footer: string;
  title?: string;
  choices?: ComposerChoice[];
  slashChoices?: ComposerChoice[];
  initialValue?: string;
  initialSelectedValue?: string;
  onInterrupt?: () => void;
};

async function readComposer(options: ComposerOptions): Promise<string | null> {
  const { renderer, footer } = options;
  const selecting = Boolean(options.choices);
  const chars = Array.from(options.initialValue ?? "");
  let cursor = chars.length;
  let selected = Math.max(0, options.choices?.findIndex((choice) => choice.value === options.initialSelectedValue) ?? 0);
  let windowStart = 0;
  const previousRaw = stdin.isRaw === true;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  const visibleChoices = () => {
    const text = chars.join("");
    if (selecting) return filterComposerChoices(options.choices ?? [], text);
    if (!text.startsWith("/") || /\s/.test(text)) return [];
    return filterComposerChoices(options.slashChoices ?? [], text.slice(1));
  };
  const draw = () => {
    const choices = visibleChoices();
    if (selected >= choices.length) selected = 0;
    if (selected < windowStart) windowStart = selected;
    if (selected >= windowStart + 8) windowStart = selected - 7;
    if (choices.length <= 8) windowStart = 0;
    const menu = choices.slice(windowStart, windowStart + 8).map((choice, index) => ({
      label: choice.label,
      detail: choice.detail,
      selected: index + windowStart === selected,
    }));
    if (!choices.length && (selecting || chars[0] === "/")) menu.push({ label: "No matches", detail: "", selected: false });
    const page = choices.length > 8 ? ` · ${windowStart + 1}–${Math.min(windowStart + 8, choices.length)}/${choices.length}` : "";
    renderer.composerFrame(chars.join(""), chars.slice(0, cursor).join(""), menu, footer, `${options.title ?? "Choose"}${page}`);
  };

  return new Promise<string | null>((resolve) => {
    const finish = (value: string | null) => {
      stdin.off("keypress", onKeypress);
      renderer.clearComposer();
      if (!previousRaw) stdin.setRawMode(false);
      resolve(value);
    };
    const onKeypress = (character: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        options.onInterrupt?.();
        return finish(null);
      }
      if (!selecting && key.ctrl && key.name === "d" && chars.length === 0) return finish(null);
      const choices = visibleChoices();
      if (key.name === "return" || key.name === "enter") {
        if (selecting) return finish(choices[selected]?.value ?? null);
        if (choices.length && chars.join("").startsWith("/") && !/\s/.test(chars.join(""))) {
          return finish(choices[selected]!.value);
        }
        return finish(chars.join(""));
      }
      if (key.name === "escape") {
        if (selecting) return finish(null);
        if (choices.length) {
          chars.splice(0);
          cursor = 0;
          selected = 0;
          draw();
        }
        return;
      }
      if ((key.name === "up" || key.name === "down") && choices.length) {
        selected = moveComposerSelection(selected, choices.length, key.name === "up" ? -1 : 1);
        draw();
        return;
      }
      if (key.name === "tab" && !selecting && choices.length) {
        chars.splice(0, chars.length, ...Array.from(choices[selected]!.value));
        cursor = chars.length;
        draw();
        return;
      }
      if (key.name === "left") cursor = Math.max(0, cursor - 1);
      else if (key.name === "right") cursor = Math.min(chars.length, cursor + 1);
      else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0;
      else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = chars.length;
      else if (key.name === "backspace" && cursor > 0) { chars.splice(--cursor, 1); selected = 0; }
      else if (key.name === "delete" && cursor < chars.length) { chars.splice(cursor, 1); selected = 0; }
      else if (key.ctrl && key.name === "u") { chars.splice(0, cursor); cursor = 0; selected = 0; }
      else if (key.ctrl && key.name === "w") {
        while (cursor > 0 && /\s/.test(chars[cursor - 1]!)) chars.splice(--cursor, 1);
        while (cursor > 0 && !/\s/.test(chars[cursor - 1]!)) chars.splice(--cursor, 1);
        selected = 0;
      } else if (!key.ctrl && !key.meta && character && !/[\u0000-\u001f\u007f]/.test(character)) {
        const inserted = Array.from(character);
        chars.splice(cursor, 0, ...inserted);
        cursor += inserted.length;
        selected = 0;
      }
      draw();
    };
    stdin.on("keypress", onKeypress);
    draw();
  });
}

export function readCommandComposer(renderer: CliRenderer, footer: string, commands: ComposerChoice[], onInterrupt: () => void): Promise<string | null> {
  return readComposer({ renderer, footer, slashChoices: commands, title: "Commands · ↑↓ select · Enter run", onInterrupt });
}

export function chooseComposerItem(renderer: CliRenderer, footer: string, title: string, choices: ComposerChoice[], initialSelectedValue?: string): Promise<string | null> {
  return readComposer({ renderer, footer, title, choices, initialSelectedValue });
}
