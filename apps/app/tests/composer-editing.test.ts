import { expect, test } from "bun:test";
import { subscribeComposerEditing } from "../src/react-app/domains/session/surface/composer/editing";

test("main composer focus, window blur and visibility drive editing independently of saved drafts", () => {
  const sourceDocument = new EventTarget() as Document;
  const sourceWindow = new EventTarget() as Window;
  let focused = true;
  let editable = false;
  let visibility = "visible";
  Object.defineProperties(sourceDocument, {
    hasFocus: { value: () => focused },
    visibilityState: { get: () => visibility },
    activeElement: { get: () => ({ matches: () => editable }) },
  });
  let editing = false;
  const release = subscribeComposerEditing((value) => { editing = value; }, sourceDocument, sourceWindow);
  expect(editing).toBe(false);
  editable = true; sourceDocument.dispatchEvent(new Event("focusin"));
  expect(editing).toBe(true);
  sourceWindow.dispatchEvent(new Event("blur")); expect(editing).toBe(false);
  sourceWindow.dispatchEvent(new Event("focus")); expect(editing).toBe(true);
  visibility = "hidden"; sourceDocument.dispatchEvent(new Event("visibilitychange")); expect(editing).toBe(false);
  visibility = "visible"; focused = false; sourceDocument.dispatchEvent(new Event("visibilitychange")); expect(editing).toBe(false);
  focused = true; editable = false; sourceDocument.dispatchEvent(new Event("focusout")); expect(editing).toBe(false);
  release(); editable = true; sourceDocument.dispatchEvent(new Event("focusin")); expect(editing).toBe(false);
});
