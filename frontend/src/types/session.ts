/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/** 场次状态 */
export type SessionState = '已排期' | '已完成' | '已取消';

/** 录制场次：某曲目某天的录制安排 */
export interface Session {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 时段 */
  period: SessionPeriod;
  /** 场次时长（分钟）；旧数据缺失时按时段默认时长回填 */
  durationMin: number;
  /** 录音师 */
  engineer: string;
  /** 棚号 */
  roomNo: string;
  /** 参与乐手（顿号分隔） */
  musicians: string;
  /** 场次状态 */
  state: SessionState;
}

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消'];

/** 每个棚每天的容量（分钟） */
export const ROOM_DAILY_CAPACITY_MIN = 480;

/** 各时段的默认场次时长（分钟），用于新建回填与旧数据迁移 */
export const PERIOD_DEFAULT_MINUTES: Record<SessionPeriod, number> = {
  上午: 240,
  下午: 240,
  晚上: 180,
  通宵: 300
};

/** 按原时段回填默认时长（未知时段按上午处理） */
export function defaultMinutesOfPeriod(period: string | undefined): number {
  return PERIOD_DEFAULT_MINUTES[period as SessionPeriod] ?? PERIOD_DEFAULT_MINUTES['上午'];
}

export function createEmptySession(): Omit<Session, 'id'> {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    durationMin: PERIOD_DEFAULT_MINUTES['上午'],
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期'
  };
}

/** 棚号候选 */
export const STUDIO_ROOMS = ['A 棚', 'B 棚', 'C 棚', '大排练厅'];
