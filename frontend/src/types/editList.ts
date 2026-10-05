/**
 * 剪接清单确认版模型：优选清单是一份可反复确认的剪接账。
 * - Take 评级一修改，引用它的当前清单立即失效（status === 'stale'）；
 * - 历次确认版作为不可变快照保留，旧确认版仍可查；
 * - 重新确认前，剪接清单导出停住（见 utils/editList.ts 的 assertExportReady）。
 */

/** 确认版中的单个片段快照 */
export interface EditListEntrySnapshot {
  pickId: string;
  order: number;
  usage: string;
  note: string;
  takeId: string;
  takeNo: string;
  startTc: string;
  endTc: string;
  /** 确认当时该 Take 的评级 */
  grade: string;
}

/** 剪接清单确认版（不可变历史记录，旧确认版仍可查） */
export interface EditListVersion {
  id: string;
  /** 确认版序号，从 1 递增 */
  version: number;
  confirmedAt: number;
  entries: EditListEntrySnapshot[];
  /** 确认时的清单签名，用于比对当前清单是否与确认版一致 */
  signature: string;
}

/** 失效引用及原因（导出拦截 / 页面点名用） */
export interface EditListInvalidRef {
  pickId: string;
  takeId: string | null;
  takeNo: string;
  reason: 'take-missing' | 'grade-changed' | 'grade-unusable';
  reasonText: string;
}

/** 清单状态：未确认 / 与最新确认版一致 / 已失效（评级改动或清单变动） */
export type EditListState = 'unconfirmed' | 'confirmed' | 'stale';

/** 当前剪接清单相对于确认版的账 */
export interface EditListStatus {
  state: EditListState;
  /** 最新确认版（可能为空） */
  latest: EditListVersion | null;
  /** 失效引用明细（state === 'stale' 时可能附带） */
  invalidRefs: EditListInvalidRef[];
  /** 给用户看的状态说明 */
  message: string;
}
