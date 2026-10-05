/**
 * 棚日容量账：把场次时长汇总到「棚 × 日」，剩余容量不足时拒绝保存并点名挤占场次。
 * 被场次 store（保存前校验）与场次安排页（容量徽标 / 存量超排提示）消费。
 */
import {
  ROOM_DAILY_CAPACITY_MIN,
  sessionDurationMin,
  type CapacityBlock,
  type CapacitySessionLike,
  type RoomDayBooking
} from '@/types/capacity';

/** 汇总某个棚某一天的占用；已取消场次不计 */
export function summarizeRoomDay(roomNo: string, date: string, sessions: CapacitySessionLike[]): RoomDayBooking {
  const booked = sessions
    .filter((item) => item.roomNo === roomNo && item.date === date && item.state !== '已取消')
    .map((item) => ({
      id: item.id,
      period: item.period,
      durationMin: sessionDurationMin(item),
      songId: item.songId
    }));
  const usedMin = booked.reduce((sum, item) => sum + item.durationMin, 0);
  return {
    roomNo,
    date,
    sessions: booked,
    usedMin,
    remainMin: ROOM_DAILY_CAPACITY_MIN - usedMin,
    overCapacity: usedMin > ROOM_DAILY_CAPACITY_MIN
  };
}

/**
 * 校验把一场（时长 candidateMin）排进指定棚日是否超容。
 * @param selfId 编辑自身时排除
 */
export function evaluateRoomDayCapacity(params: {
  roomNo: string;
  date: string;
  candidateMin: number;
  sessions: CapacitySessionLike[];
  selfId?: string | null;
}): CapacityBlock {
  const others = params.sessions.filter((item) => item.id !== params.selfId);
  const booking = summarizeRoomDay(params.roomNo, params.date, others);
  const remain = ROOM_DAILY_CAPACITY_MIN - booking.usedMin;
  const blocked = params.candidateMin > remain;
  const over = params.candidateMin - remain;
  const message = blocked
    ? `${params.roomNo} ${params.date} 棚日容量 ${ROOM_DAILY_CAPACITY_MIN} 分钟：已有 ${booking.sessions.length} 场合计 ${booking.usedMin} 分钟，本场 ${params.candidateMin} 分钟将超出 ${over} 分钟（剩余 ${remain} 分钟）。挤占场次：${booking.sessions
        .map((item) => `${item.period} ${item.durationMin} 分钟（场次 ${item.id}）`)
        .join('、')}。请压缩时长、换棚或换日。`
    : '';
  return {
    blocked,
    roomNo: params.roomNo,
    date: params.date,
    requiredMin: params.candidateMin,
    usedMin: booking.usedMin,
    remainMin: remain,
    blockingSessions: booking.sessions,
    message
  };
}

/** 找出全部已经超容的棚日（用于页面顶部点名提示存量超排） */
export function findOverCapacityDays(sessions: CapacitySessionLike[]): RoomDayBooking[] {
  const keys = new Set<string>();
  sessions
    .filter((item) => item.state !== '已取消')
    .forEach((item) => keys.add(`${item.roomNo}|${item.date}`));
  const result: RoomDayBooking[] = [];
  keys.forEach((key) => {
    const [roomNo, date] = key.split('|');
    const booking = summarizeRoomDay(roomNo, date, sessions);
    if (booking.overCapacity) result.push(booking);
  });
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.roomNo.localeCompare(b.roomNo));
}

/** 分钟数展示：480 → 480 分钟；超过 60 分钟附带小时 */
export function formatMinutes(totalMin: number): string {
  const safe = Math.max(0, Math.round(totalMin));
  if (safe < 60) return `${safe} 分钟`;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
}
