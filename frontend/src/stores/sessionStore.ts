/**
 * 场次 store：维护场次排期、棚号时段冲突与棚日容量校验、筛选条件。
 * 棚日账：每个棚每天 480 分钟，剩余容量不足时拒绝保存并点名挤占的场次。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import {
  findRoomConflict,
  listSessions,
  putSession,
  removeSession,
  updateSession
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';
import { sessionDurationMin } from '@/types/capacity';
import { evaluateRoomDayCapacity } from '@/utils/capacity';

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
  assertRoomFree: (roomNo: string, date: string, period: string, selfId: string | null) => Promise<void>;
  /** 校验棚日容量（含时段冲突），不通过则抛出带挤占场次的错误 */
  assertRoomDayFits: (candidate: Omit<Session, 'id'>, selfId: string | null) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  assertRoomFree: async (roomNo, date, period, selfId) => {
    const conflict = await findRoomConflict(roomNo, date, period, selfId);
    if (conflict) {
      throw new Error(`${roomNo} 在 ${date} ${period} 已被场次占用（场次 ${conflict.id}），请换棚或换时段`);
    }
  },
  assertRoomDayFits: async (candidate, selfId) => {
    // 取消的场次不占棚日容量，也不参与冲突
    if (candidate.state === '已取消') return;
    await get().assertRoomFree(candidate.roomNo, candidate.date, candidate.period, selfId);
    const all = await listSessions();
    const minutes = sessionDurationMin(candidate);
    const block = evaluateRoomDayCapacity({
      roomNo: candidate.roomNo,
      date: candidate.date,
      candidateMin: minutes,
      sessions: all,
      selfId
    });
    if (block.blocked) {
      throw new Error(block.message);
    }
  },
  createSession: async (payload) => {
    await get().assertRoomDayFits(payload, null);
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch) => {
    // 容量校验需要合并后的完整行（部分 patch 也要先读出现值）
    const existing = (await listSessions()).find((item) => item.id === id);
    if (existing) {
      const merged: Omit<Session, 'id'> = {
        songId: patch.songId ?? existing.songId,
        date: patch.date ?? existing.date,
        period: patch.period ?? existing.period,
        durationMin: patch.durationMin ?? existing.durationMin,
        engineer: patch.engineer ?? existing.engineer,
        roomNo: patch.roomNo ?? existing.roomNo,
        musicians: patch.musicians ?? existing.musicians,
        state: patch.state ?? existing.state
      };
      await get().assertRoomDayFits(merged, id);
    }
    await updateSession(id, patch);
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
