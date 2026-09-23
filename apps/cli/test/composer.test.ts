import assert from "node:assert/strict";
import test from "node:test";
import { filterComposerChoices, moveComposerSelection } from "../src/composer.js";

test("composer filters slash/model options and wraps arrow selection", () => {
  const choices = [
    { value: "/model", label: "/model", detail: "Choose model" },
    { value: "/org", label: "/org", detail: "Cloud organization" },
  ];
  assert.deepEqual(filterComposerChoices(choices, "model").map((choice) => choice.value), ["/model"]);
  assert.deepEqual(filterComposerChoices(choices, "cloud").map((choice) => choice.value), ["/org"]);
  assert.equal(moveComposerSelection(0, 2, -1), 1);
  assert.equal(moveComposerSelection(1, 2, 1), 0);
  assert.equal(moveComposerSelection(0, 0, 1), 0);
});
