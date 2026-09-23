import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import type { CliOptions } from "./args.js";

export type OnboardingChoice = "browser" | "paste" | "continue" | "cancel";
const CHOICES = ["browser", "paste", "continue"] as const;
const RESET = "\u001b[0m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";

export function isOnboardingEntry(options: CliOptions, interactive: boolean): boolean {
  return interactive && options.command.group === "runtime" && options.command.action === "run" &&
    !options.prompt && !options.continueLatest && !options.serverUrl;
}

export function nextOnboardingSelection(current: number, direction: "up" | "down"): number {
  return (current + (direction === "up" ? CHOICES.length - 1 : 1)) % CHOICES.length;
}

export function renderOnboarding(selected: number, color: boolean): string {
  const style = (value: string, code: string) => color ? `${code}${value}${RESET}` : value;
  const options = [
    ["Sign in with JuggleWork Cloud", "Open a browser and paste the one-time handoff link"],
    ["Paste a one-time handoff", "Use a browser on another device or remote terminal"],
    ["Continue without Cloud", "Local or connected runtime; Cloud inventory unavailable"],
  ] as const;
  const lines = [
    "Welcome to JuggleWork, your command-line coding agent",
    "",
    "Sign in to JuggleWork Cloud to use your organization's published",
    "providers and models. You can also continue without Cloud.",
    "",
  ];
  options.forEach(([title, description], index) => {
    const active = index === selected;
    lines.push(`${active ? style(">", CYAN) : " "} ${style(`${index + 1}. ${title}`, active ? CYAN : RESET)}`);
    lines.push(`    ${style(description, active ? CYAN : DIM)}`);
    lines.push("");
  });
  lines.push(style("Press enter to continue · ↑↓ to choose · 1–3 to select", DIM));
  return `${lines.join("\n")}\n`;
}

export async function chooseCloudOnboarding(color: boolean): Promise<OnboardingChoice> {
  if (!stdin.isTTY || !stdout.isTTY) return "cancel";
  if (process.env.TERM === "dumb" || typeof stdin.setRawMode !== "function") {
    stdout.write(`\n${renderOnboarding(0, false)}`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await new Promise<string>((resolve) => rl.question("Choose [1]: ", resolve))).trim();
      return CHOICES[Number(answer || "1") - 1] ?? "cancel";
    } finally {
      rl.close();
    }
  }

  let selected = 0;
  const previousRaw = stdin.isRaw;
  const paint = () => stdout.write(`\u001b[?25l\u001b[2J\u001b[H${renderOnboarding(selected, color)}`);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  paint();
  return new Promise<OnboardingChoice>((resolve) => {
    const finish = (choice: OnboardingChoice) => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write("\u001b[?25h\u001b[2J\u001b[H");
      resolve(choice);
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") return finish("cancel");
      if (key.name === "escape") return finish("cancel");
      if (key.name === "up" || key.name === "down") {
        selected = nextOnboardingSelection(selected, key.name);
        return paint();
      }
      if (/^[1-3]$/.test(text)) {
        selected = Number(text) - 1;
        return paint();
      }
      if (key.name === "return" || key.name === "enter") finish(CHOICES[selected]!);
    };
    stdin.on("keypress", onKeypress);
  });
}
