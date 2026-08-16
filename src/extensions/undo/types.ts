/**
 * Undo/redo 扩展类型定义。
 *
 * 快照采用内容寻址(sha256):文件内容以 blob 落盘,PICO_HOME/agent/cache/undo/ 下;
 * 内存只存元数据(路径 + hash + 时间戳)。一条 undo 条目 = 一次 edit/write
 * 工具调用前后的文件状态。
 */

/** 一个文件在某个时刻的状态(内容寻址)。hash === null 表示文件当时不存在。 */
export interface FileSnapshot {
  /** 内容 sha256;null = 文件当时不存在(新增前/删除后) */
  hash: string | null;
  /** blob 字节数(仅 hash 非空时有意义) */
  size?: number;
}

/** 捕获工具范围:上游唯一两个文件写工具(无 apply_patch) */
export type UndoTool = "edit" | "write";

/** 一条 undo/redo 条目 = 一次 edit/write 工具调用前后的文件状态 */
export interface UndoEntry {
  /** 唯一 id(时间戳 + 计数) */
  id: string;
  /** 触发工具 */
  tool: UndoTool;
  /** 文件绝对路径 */
  path: string;
  /** 相对 cwd 的展示路径 */
  displayPath: string;
  /** 修改前的文件状态(undo 目标) */
  before: FileSnapshot;
  /** 修改后的文件状态(redo 目标) */
  after: FileSnapshot;
  /** 工具调用 id(toolCallId) */
  toolCallId: string;
  /** 时间戳(ms) */
  at: number;
}

/** tool_call 后、tool_result 前的暂存捕获 */
export interface PendingCapture {
  tool: UndoTool;
  path: string;
  displayPath: string;
  before: FileSnapshot;
}

/** 单会话 undo 状态 */
export interface UndoSessionState {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** tool_call 后等待 tool_result 确认的捕获,按 toolCallId */
  pending: Map<string, PendingCapture>;
}

/** undo/redo 命令执行结果(供 UI 通知与测试断言) */
export interface UndoResult {
  ok: boolean;
  message: string;
  /** 本次恢复的文件(路径 → 变更类型) */
  files: Array<{ path: string; action: "restored" | "deleted" | "created" }>;
}

/** 配置(settings.json 的 undo 命名空间) */
export interface UndoConfig {
  enabled: boolean;
  /** undo 栈上限,超出淘汰最旧 */
  maxEntries: number;
}
