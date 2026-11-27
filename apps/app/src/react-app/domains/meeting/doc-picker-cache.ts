/** 会议内的云文档列表缓存：再次打开选择器先显示上次结果，同时后台刷新；离会时清空。 */
export type DocPickerItem = { workspaceId: string; docId: string; title: string; updatedAt: string; scope?: string; contentKind?: string };

const cache = new Map<string, DocPickerItem[]>();
export const docPickerCache = {
  get: (query: string) => cache.get(query),
  set: (query: string, items: DocPickerItem[]) => { cache.set(query, items); },
  clear: () => cache.clear(),
};
