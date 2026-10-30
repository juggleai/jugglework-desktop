import { expect, test } from "bun:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { ImeTextarea } from "../src/pet/ime-textarea";

test("IME preedit stays native and only committed text reaches the draft", async () => {
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const committed: string[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(<ImeTextarea value="" onCommit={(value) => committed.push(value)} />); });
    const props = () => renderer!.root.findByType("textarea").props;
    expect(props().value).toBeUndefined();
    const field = { value: "nihao" };
    await act(async () => props().onCompositionStart({ currentTarget: field }));
    await act(async () => props().onChange({ currentTarget: field, nativeEvent: { isComposing: true } }));
    await act(async () => props().onBlur({ currentTarget: field }));
    expect(committed).toEqual([]);
    await act(async () => renderer!.update(<ImeTextarea value="stale host snapshot" onCommit={(value) => committed.push(value)} />));
    field.value = "你好";
    await act(async () => props().onCompositionEnd({ currentTarget: field }));
    expect(committed).toEqual(["你好"]);
    field.value = "你好啊";
    await act(async () => props().onChange({ currentTarget: field, nativeEvent: { isComposing: false } }));
    expect(committed).toEqual(["你好", "你好啊"]);
  } finally {
    await act(async () => renderer?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});
