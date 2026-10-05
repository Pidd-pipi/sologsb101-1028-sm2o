/**
 * 场次 store：维护场次排期、棚号时段冲突、棚日容量校验与筛选条件。
 * 每个棚每天按 480 分钟安排；剩余容量不足时拒绝保存并点名挤占的场次。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import { ROOM_DAILY_CAPACITY_MIN } from '@/types/session';
import {
  checkRoomCapacity,
  findRoomConflict,
  getSession,
  listSongs,
  putSession,
  removeSession,
  updateSession
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  createSession: (payload: Omit<Session, 'id'>) => Promise<string>;
  editSession: (id: string, patch: Partial<Session>) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

async function assertRoomFree(roomNo: string, date: string, period: string, selfId: string | null): Promise<void> {
  const conflict = await findRoomConflict(roomNo, date, period, selfId);
  if (conflict) {
    throw new Error(`${roomNo} 在 ${date} ${period} 已被场次占用（场次 ${conflict.id}），请换棚或换时段`);
  }
}

/** 棚日容量闸口：超时抛错并点名挤占场次 */
async function assertRoomCapacity(candidate: Parameters<typeof checkRoomCapacity>[0]): Promise<void> {
  const songs = await listSongs();
  const overflow = await checkRoomCapacity(candidate, songs);
  if (!overflow) return;
  const names = overflow.occupants
    .map((item) => `《${item.songTitle}》${item.session.period} ${item.session.durationMin} 分钟`)
    .join('、');
  throw new Error(
    `${overflow.roomNo} ${overflow.date} 当日容量 ${ROOM_DAILY_CAPACITY_MIN} 分钟已排满：` +
      `加上本场共需 ${overflow.usedMin} 分钟，超出 ${-overflow.remainingMin} 分钟。` +
      `挤占容量的场次：${names || '（无）'}。请缩短时长、换棚或改期`
  );
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  createSession: async (payload) => {
    await assertRoomFree(payload.roomNo, payload.date, payload.period, null);
    await assertRoomCapacity({ ...payload });
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch) => {
    const previous = await getSession(id);
    if (!previous) throw new Error('待编辑的场次不存在或已被删除');
    const merged: Session = { ...previous, ...patch };
    // 排期三要素或状态可能变化时重查时段冲突（取消的场次不再占位）
    if (
      merged.state !== '已取消' &&
      (patch.roomNo !== undefined ||
        patch.date !== undefined ||
        patch.period !== undefined ||
        patch.state !== undefined)
    ) {
      await assertRoomFree(merged.roomNo, merged.date, merged.period, id);
    }
    // 容量与棚号 / 日期 / 时长 / 状态都可能相关
    if (
      patch.roomNo !== undefined ||
      patch.date !== undefined ||
      patch.durationMin !== undefined ||
      patch.state !== undefined
    ) {
      await assertRoomCapacity({ ...merged, id });
    }
    await updateSession(id, patch);
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
