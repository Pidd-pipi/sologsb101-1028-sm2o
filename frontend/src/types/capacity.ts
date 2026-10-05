/**
 * 棚日容量模型：每个棚每天按固定分钟数安排场次。
 * 场次只登记上午 / 下午 / 晚上 / 通宵，没有场次时长的历史数据按时段默认值回填。
 */
import type { SessionPeriod } from './session';

/** 每个棚每天的可用容量（分钟）：8 小时 */
export const ROOM_DAILY_CAPACITY_MIN = 480;

/** 各时段默认时长（分钟）：历史场次没有时长时按原时段回填 */
export const PERIOD_DEFAULT_MINUTES: Record<SessionPeriod, number> = {
  上午: 240,
  下午: 240,
  晚上: 180,
  通宵: 480
};

/**
 * 取场次时长（分钟）：缺省 / 非法时按时段回填默认值。
 * 旧数据没有场次时长字段时，按原时段（上午 / 下午 / 晚上 / 通宵）回填。
 */
export function sessionDurationMin(session: {
  period: SessionPeriod;
  durationMin?: number | null;
}): number {
  if (typeof session.durationMin === 'number' && Number.isFinite(session.durationMin) && session.durationMin > 0) {
    return Math.round(session.durationMin);
  }
  return PERIOD_DEFAULT_MINUTES[session.period] ?? ROOM_DAILY_CAPACITY_MIN;
}

/** 棚日占用明细：同一棚同一天所有未取消场次 */
export interface RoomDayBooking {
  roomNo: string;
  date: string;
  /** 已排场次（未取消） */
  sessions: Array<{ id: string; period: SessionPeriod; durationMin: number; songId: string }>;
  /** 已占用分钟数 */
  usedMin: number;
  /** 剩余容量（分钟，可能为负表示已经超容） */
  remainMin: number;
  /** 是否超容 */
  overCapacity: boolean;
}

/** 容量校验结果：保存场次时剩余容量不足则拒绝，并点名挤占的场次 */
export interface CapacityBlock {
  blocked: boolean;
  roomNo: string;
  date: string;
  /** 本次保存需要的分钟数 */
  requiredMin: number;
  usedMin: number;
  remainMin: number;
  /** 挤占（同棚同日已排、导致容量不够）的场次 */
  blockingSessions: RoomDayBooking['sessions'];
  message: string;
}

/** 容量计算所需的场次最小结构 */
export interface CapacitySessionLike {
  id: string;
  roomNo: string;
  date: string;
  period: SessionPeriod;
  durationMin?: number | null;
  state: string;
  songId: string;
}
