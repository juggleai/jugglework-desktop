import { expect, test } from "bun:test";
import { emojiPlacement } from "../src/react-app/domains/tasks/task-emoji-picker";

test("emoji picker uses the scroll pane above the comment footer, not the whole window", () => {
  const toolbar = { top: 440, bottom: 488 };
  expect(emojiPlacement(toolbar, 64, 900)).toEqual({ above: false, maxHeight: 336 });
  expect(emojiPlacement(toolbar, 64, 620)).toEqual({ above: true, maxHeight: 336 });
});

test("limited space bounds the picker on whichever side has more room", () => {
  const toolbar = { top: 180, bottom: 228 };
  expect(emojiPlacement(toolbar, 48, 365)).toEqual({ above: false, maxHeight: 129 });
  expect(emojiPlacement(toolbar, 48, 315)).toEqual({ above: true, maxHeight: 124 });
});
