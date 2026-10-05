/**
 * 优选 store：维护优选顺序、剪接清单派生、备注与确认版。
 * Take 评级修改后当前清单立即失效；确认版作为不可变快照保留，旧确认版仍可查；
 * 重新确认前导出由 utils/editList 的 assertExportReady 拦住。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Pick } from '@/types/pick';
import {
  nextPickOrder,
  putPick,
  removePick,
  reorderPicks,
  updatePick,
  listTakes,
  listPicks,
  nextEditListVersionNo,
  putEditListVersion
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';
import { buildEditListSnapshot } from '@/utils/editList';
import { ROW_REVISION } from '@/utils/revision';
import type { EditListVersionRow } from '@/utils/db';

export const PICK_FILTER_KEYS = ['usages'];

interface PickState {
  filters: FilterModel;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  createPick: (payload: Omit<Pick, 'id' | 'order'>) => Promise<string>;
  editPick: (id: string, patch: Partial<Pick>) => Promise<void>;
  deletePick: (id: string) => Promise<void>;
  move: (list: Pick[], from: number, to: number) => Promise<void>;
  /** 确认当前优选清单为新的剪接清单版本；有失效引用时抛错 */
  confirmEditList: () => Promise<EditListVersionRow>;
}

export const usePickStore = create<PickState>()((set) => ({
  filters: { keyword: '', usages: [] },
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', usages: [] } }),
  createPick: async (payload) => {
    const order = await nextPickOrder();
    const row = buildRow({ ...payload, order }, 'pick');
    await putPick(row);
    return row.id;
  },
  editPick: async (id, patch) => {
    await updatePick(id, patch);
  },
  deletePick: async (id) => {
    await removePick(id);
  },
  move: async (list, from, to) => {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await reorderPicks(next.map((item) => item.id));
  },
  confirmEditList: async () => {
    const [picks, takes] = await Promise.all([listPicks(), listTakes()]);
    if (picks.length === 0) {
      throw new Error('剪接清单为空，没有可确认的优选条目');
    }
    const versionNo = await nextEditListVersionNo();
    const snapshot = buildEditListSnapshot({ picks, takes, nextVersion: versionNo });
    const now = Date.now();
    const row: EditListVersionRow = {
      ...snapshot,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    };
    await putEditListVersion(row);
    return row;
  }
}));
