import { useSyncExternalStore } from "react";

import { getLocaleSnapshot, subscribeLocale, type Language } from "./index";

/**
 * 订阅当前界面语言
 *
 * TIPS: `t()` 在渲染期读取模块级变量，React 无法感知语言变化。
 * 在应用根节点调用一次本 hook，即可让整棵树在切换语言后立即重渲染
 * （只是重渲染，不会卸载重挂载，因此不会重连服务端或丢失会话状态）。
 *
 * @returns 当前语言代码
 */
export const useLocale = (): Language =>
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
