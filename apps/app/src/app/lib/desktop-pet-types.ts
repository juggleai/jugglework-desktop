/** 桌面宠物只接收展示数据，服务令牌和业务客户端保留在主任务宿主。 */
export type PetTaskState = "running" | "waiting" | "resumable" | "reconciling" | "completed";

export type PetTarget = {
  key: string;
  workspaceId: string;
  sessionId: string;
  project: string;
  title: string;
};

/** PET 只传可序列化的展示字段；能力指令由宿主按当前清单生成。 */
export type PetCapability = {
  id: string;
  group: "plugins" | "mcp" | "skills";
  name: string;
  description?: string;
  iconSrc?: string;
  kind: "skill" | "cloud-skill" | "extension" | "mcp" | "cloud-mcp";
  prompt?: string;
  disabled?: boolean;
};

export type PetTask = PetTarget & {
  turnKey: string;
  state: PetTaskState;
  statusText: string;
  progressText?: string;
  canStop: boolean;
  /** 当前轮已确认停止，不包含仍在停止对账中的任务。 */
  stopped?: boolean;
  preparing?: boolean;
  stopping?: boolean;
};

export type PetSnapshot = {
  contextKey?: string;
  interaction?: PetInteraction;
  /** 主进程持有的发送中任务键；同一会话的所有宠物输入入口共用保护。 */
  submitting?: string[];
  visible: boolean;
  ready: boolean;
  syncing: boolean;
  partial: boolean;
  tasks: PetTask[];
  locale: "zh" | "en";
  theme: "light" | "dark";
  editing: boolean;
  /** 主会话输入框正在聚焦编辑；独立于宠物页面的编辑状态。 */
  mainComposerEditing?: boolean;
  voicePhase: string;
  voiceAvailable?: boolean;
  voiceChecking?: boolean;
  voiceText?: string;
  voiceError?: string;
};

/** 仅驻留主进程内存的交互状态，隐藏窗口不丢草稿，注销时清空。 */
export type PetInteraction = {
  drafts: Record<string, string>;
  /** 与文字共用草稿键，能力单独构成的草稿也由主进程保留。 */
  selectedCapabilities?: Record<string, PetCapability[]>;
  targets: Record<string, PetTarget>;
  dismissed: Record<string, string>;
  /** 已打开阅读的完成轮次；新用户轮次不继承已读状态。 */
  read?: Record<string, string>;
  target: PetTarget | null;
  /** 按项目及会话的任务键记录未知发送结果，由主进程维护。 */
  uncertain?: Record<string, boolean>;
};

export type PetAction =
  | { type: "latest" }
  | { type: "sessions" }
  | { type: "capabilities"; target: PetTarget; scope: "basic" | "connections" }
  | { type: "open-app" }
  | { type: "activate-app" }
  | { type: "send"; target: PetTarget; text: string; draftKey: string; capabilities?: PetCapability[] }
  | { type: "confirm-send"; key: string }
  | { type: "open-target"; target: PetTarget }
  | { type: "continue" | "stop" | "open"; key: string; text?: string }
  | { type: "voice-start"; target: PetTarget }
  | { type: "voice-stop" | "voice-cancel" }
  | { type: "editing"; active: boolean }
  | { type: "restore" };

export type PetActionResult = {
  target?: PetTarget;
  /** 可发送的主会话，按最近更新时间排序，包含没有任务提醒的会话。 */
  targets?: PetTarget[];
  capabilities?: PetCapability[];
  delivery?: "sent" | "queued";
  /** 宿主确认发送后的任务投影，用于在下一次状态广播前立即展示。 */
  task?: PetTask;
  /** 主进程已确认清理本次原草稿；提交后的新编辑不会被清理。 */
  draftCleared?: boolean;
  partial?: boolean;
};

export type PetLayout = {
  width: number;
  height: number;
  character: { x: number; y: number };
  regions: Array<{ x: number; y: number; width: number; height: number }>;
};

/** 固定透明画布和人物锚点，由主进程按显示器工作区更新。 */
export type PetViewport = {
  width: number;
  height: number;
  screenX: number;
  character: { x: number; y: number };
  workArea: { x: number; y: number; width: number; height: number };
};

/** 主窗口与原生宠物窗口共用的有限通信接口。 */
export type DesktopPetBridge = {
  getState(): Promise<PetSnapshot>;
  setVisible(visible: boolean): Promise<PetSnapshot>;
  focus(): Promise<void>;
  onState(callback: (state: PetSnapshot) => void): () => void;
  publish(state: Omit<PetSnapshot, "visible">): void;
  onAction(callback: (action: PetAction) => Promise<PetActionResult | void>): () => void;
};

/** 宠物页面不获得普通桌面命令或访问令牌。 */
export type PetWindowBridge = {
  getViewport(): Promise<PetViewport>;
  onViewport(callback: (viewport: PetViewport) => void): () => void;
  getState(): Promise<PetSnapshot>;
  onState(callback: (state: PetSnapshot) => void): () => void;
  action(action: PetAction): Promise<PetActionResult>;
  layout(layout: PetLayout): void;
  keyboard(active: boolean): void;
  /** 原生窗口可接收键盘输入后再聚焦新挂载的编辑框。 */
  focusEditor(): Promise<void>;
  drag(active: boolean): void;
  /** 保存当前账号上下文的交互状态，拒绝账号切换前的延迟写入。 */
  remember(value: PetInteraction, contextKey: string | undefined): void;
  hide(): Promise<void>;
  onFocus(callback: () => void): () => void;
};
