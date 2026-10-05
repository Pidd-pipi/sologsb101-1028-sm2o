import type { TakeGrade } from './take';

/** 优选用途 */
export type PickUsage = '主歌' | '副歌' | '独奏' | '全曲';

/** 优选 Take：从可用条次中挑选出的剪接素材 */
export interface Pick {
  id: string;
  /** 被优选的 Take */
  takeId: string;
  /** 用途 */
  usage: PickUsage;
  /** 剪接清单中的顺序 */
  order: number;
  /** 备注 */
  note: string;
  /**
   * 最近一次确认剪接清单时该 Take 的评级快照。
   * null 表示新增后从未确认；与 Take 当前评级不一致即为「评级改动导致失效」。
   */
  snapshotGrade: TakeGrade | null;
}

/** 一次确认动作冻结下来的单条优选（不再随后续编辑变化） */
export interface PickSnapshotItem {
  pickId: string;
  takeId: string;
  takeNo: string;
  startTc: string;
  endTc: string;
  grade: TakeGrade | null;
  usage: PickUsage;
  order: number;
  note: string;
}

/** 剪接清单确认版：每次确认生成一版，旧确认版永久留查 */
export interface PickSnapshot {
  id: string;
  /** 确认时间 ISO */
  confirmedAt: string;
  /** 确认时清单条数 */
  itemCount: number;
  /** 冻结的清单内容 */
  items: PickSnapshotItem[];
}

export const PICK_USAGES: PickUsage[] = ['主歌', '副歌', '独奏', '全曲'];

export function createEmptyPick(): Omit<Pick, 'id' | 'order' | 'snapshotGrade'> {
  return { takeId: '', usage: '主歌', note: '' };
}
