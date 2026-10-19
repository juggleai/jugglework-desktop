/** 文件侧栏和文件浏览器共享的文本草稿身份。 */
export interface FileEditorTarget {
  workspaceId: string;
  path: string;
}
/** 文本草稿保留磁盘基准，保存冲突时不覆盖外部修改。 */
export interface FileEditorDraft {
  content: string;
  baseUpdatedAt: number | null;
}
/** 一份文本草稿及其已保存版本，按文件同步到当前桌面的所有视图。 */
export interface FileEditorState extends FileEditorTarget {
  draft: FileEditorDraft | null;
  saved: { content: string; updatedAt: number; size: number } | null;
  external: boolean;
}
/** Electron 共用文本编辑入口，退出和另存为使用相同保存逻辑。 */
export interface FileEditorBridge {
  state(input: FileEditorTarget): Promise<FileEditorState>;
  update(
    input: FileEditorTarget,
    draft: FileEditorDraft | null,
  ): Promise<FileEditorState>;
  save(input: FileEditorTarget): Promise<FileEditorState>;
  prepare(input: FileEditorTarget): Promise<boolean>;
  close(input: FileEditorTarget): Promise<boolean>;
  external(input: FileEditorTarget, external: boolean): Promise<void>;
  onChanged(callback: (state: FileEditorState) => void): () => void;
}
