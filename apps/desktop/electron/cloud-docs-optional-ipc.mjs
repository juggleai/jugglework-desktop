/**
 * 调用可选能力。开发版热更新时 preload 可能比 Main 先更新，只在同一通道确实缺失时回退。
 * @param {Function} invoke Electron 的 invoke
 * @param {string} channel 可选能力通道
 * @param {unknown} input 请求参数
 * @param {unknown} fallback 旧 Main 的返回值
 */
export async function invokeOptionalCloudDocs(invoke, channel, input, fallback) {
  try {
    return await invoke(channel, input);
  } catch (error) {
    if (typeof error?.message === "string" && error.message.includes(`No handler registered for '${channel}'`))
      return fallback;
    throw error;
  }
}
