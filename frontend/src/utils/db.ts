/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 / 剪接清单确认版 七张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session } from '../types/session';
import type { Take } from '../types/take';
import type { Pick } from '../types/pick';
import type { Retake } from '../types/retake';
import type { EditListVersion } from '../types/editList';
import { PERIOD_DEFAULT_MINUTES } from '../types/capacity';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';

/** 数据库名 */
export const DB_NAME = 'gbstudiotake-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号（定义在叶子模块 ./revision，避免与 ./seed 形成循环依赖） */
export { ROW_REVISION };

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ProjectRow = Project & Revisioned;
export type SongRow = Song & Revisioned;
export type SessionRow = Session & Revisioned;
export type TakeRow = Take & Revisioned;
export type PickRow = Pick & Revisioned;
export type RetakeRow = Retake & Revisioned;
export type EditListVersionRow = EditListVersion & Revisioned;

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;
  editListVersions!: Table<EditListVersionRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：六张基础表
    this.version(1).stores({
      projects: 'id, name, client, state, startDate, updatedAt',
      songs: 'id, projectId, title, arrangement, state, updatedAt',
      sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
      takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
      picks: 'id, takeId, usage, order, updatedAt',
      retakes: 'id, songId, planDate, state, updatedAt'
    });

    // v2：场次增加 durationMin（旧数据按原时段回填）；新增剪接清单确认版表
    this.version(2)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt',
        editListVersions: 'id, version, confirmedAt'
      })
      .upgrade(async (tx) => {
        // 场次时长回填：旧数据没有场次时长时按原时段（上午/下午/晚上/通宵）回填
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const duration = row.durationMin;
            if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
              row.durationMin = PERIOD_DEFAULT_MINUTES[row.period as keyof typeof PERIOD_DEFAULT_MINUTES] ?? 480;
            }
          });
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes', 'editListVersions'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });
  }
}

export const db = new GbStudioTakeDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.projects.count()) === 0) {
    await seedDatabase(db);
  }
}

/* ------------------------------ 项目 ------------------------------ */

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.projects.toArray();
  return rows.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function putProject(row: ProjectRow): Promise<void> {
  await db.projects.put(row);
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除项目：级联删除曲目、场次、Take、优选与补录 */
export async function removeProject(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes, db.editListVersions],
    async () => {
      const songs = await db.songs.where('projectId').equals(id).toArray();
      for (const song of songs) {
        await cascadeRemoveSong(song.id);
      }
      await db.projects.delete(id);
    }
  );
}

/* ------------------------------ 曲目 ------------------------------ */

export async function listSongs(): Promise<SongRow[]> {
  const rows = await db.songs.toArray();
  return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

export async function putSong(row: SongRow): Promise<void> {
  await db.songs.put(row);
}

export async function updateSong(id: string, patch: Partial<Song>): Promise<void> {
  await db.songs.update(id, { ...patch, updatedAt: Date.now() } as never);
}

async function cascadeRemoveSong(songId: string): Promise<void> {
  const sessions = await db.sessions.where('songId').equals(songId).toArray();
  const sessionIds = sessions.map((item) => item.id);
  if (sessionIds.length > 0) {
    const takes = await db.takes.where('sessionId').anyOf(sessionIds).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').anyOf(sessionIds).delete();
    await db.sessions.where('songId').equals(songId).delete();
  }
  await db.retakes.where('songId').equals(songId).delete();
  await db.songs.delete(songId);
}

export async function removeSong(id: string): Promise<void> {
  await db.transaction('rw', [db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await cascadeRemoveSong(id);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listSessions(): Promise<SessionRow[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putSession(row: SessionRow): Promise<void> {
  await db.sessions.put(row);
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  await db.sessions.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/**
 * 校验棚号时段冲突：同一棚号同一日期同一时段只能有一场（已取消的除外）
 * @param selfId 编辑自身时排除
 */
export async function findRoomConflict(
  roomNo: string,
  date: string,
  period: string,
  selfId: string | null
): Promise<SessionRow | null> {
  const rows = await db.sessions
    .where('roomNo')
    .equals(roomNo)
    .filter((item) => item.date === date && item.period === period && item.state !== '已取消' && item.id !== selfId)
    .toArray();
  return rows[0] ?? null;
}

/** 删除场次：级联删除其 Take 与对应优选 */
export async function removeSession(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const takes = await db.takes.where('sessionId').equals(id).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

/* ------------------------------ Take ------------------------------ */

export async function listTakes(): Promise<TakeRow[]> {
  return db.takes.toArray();
}

export async function putTake(row: TakeRow): Promise<void> {
  await db.takes.put(row);
}

/**
 * 更新 Take：patch 中带 grade 且与现值不同（或现值是历史数据从未改过）时，
 * 记录 gradeChangedAt —— 引用它的剪接清单据此立即失效。
 */
export async function updateTake(id: string, patch: Partial<Take>): Promise<void> {
  const next: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
  if (typeof patch.grade === 'string') {
    const current = await db.takes.get(id);
    if (current && current.grade !== patch.grade) {
      next.gradeChangedAt = Date.now();
    }
  }
  await db.takes.update(id, next as never);
}

/** 批量改评级：评级发生变化的条次记录 gradeChangedAt，联动其优选清单失效；返回实际变化条数 */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<number> {
  let changed = 0;
  await db.transaction('rw', [db.takes], async () => {
    const now = Date.now();
    for (const id of ids) {
      const current = await db.takes.get(id);
      const patch: Record<string, unknown> = { grade, updatedAt: now };
      if (current && current.grade !== grade) {
        patch.gradeChangedAt = now;
        changed += 1;
      }
      await db.takes.update(id, patch as never);
    }
  });
  return changed;
}

export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.takes, db.picks], async () => {
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选 ------------------------------ */

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function putPick(row: PickRow): Promise<void> {
  await db.picks.put(row);
}

export async function updatePick(id: string, patch: Partial<Pick>): Promise<void> {
  await db.picks.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 拖拽 / 上下移后按新顺序批量写回 */
export async function reorderPicks(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.picks], async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.picks.update(orderedIds[index], { order: index + 1, updatedAt: Date.now() } as never);
    }
  });
}

export async function nextPickOrder(): Promise<number> {
  const rows = await db.picks.toArray();
  return rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
}

export async function removePick(id: string): Promise<void> {
  await db.picks.delete(id);
}

/* ------------------------ 剪接清单确认版 ------------------------ */

export async function listEditListVersions(): Promise<EditListVersionRow[]> {
  const rows = await db.editListVersions.toArray();
  return rows.sort((a, b) => b.version - a.version);
}

export async function putEditListVersion(row: EditListVersionRow): Promise<void> {
  await db.editListVersions.put(row);
}

export async function nextEditListVersionNo(): Promise<number> {
  const count = await db.editListVersions.count();
  return count + 1;
}

/** 删除确认版历史（重新开始记账时用）；不影响当前优选条目 */
export async function clearEditListVersions(): Promise<void> {
  await db.editListVersions.clear();
}

/* ------------------------------ 补录 ------------------------------ */

export async function listRetakes(): Promise<RetakeRow[]> {
  const rows = await db.retakes.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putRetake(row: RetakeRow): Promise<void> {
  await db.retakes.put(row);
}

export async function updateRetake(id: string, patch: Partial<Retake>): Promise<void> {
  await db.retakes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 补录完成：联动曲目状态 */
export async function completeRetake(id: string): Promise<void> {
  await db.transaction('rw', [db.retakes, db.songs], async () => {
    const retake = await db.retakes.get(id);
    if (!retake) throw new Error('补录条目不存在');
    await db.retakes.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.retakes
      .where('songId')
      .equals(retake.songId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.songs.update(retake.songId, { state: pending === 0 ? '已完成' : '录制中', updatedAt: Date.now() } as never);
  });
}

export async function removeRetake(id: string): Promise<void> {
  await db.retakes.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
  editListVersions: EditListVersion[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, songs, sessions, takes, picks, retakes, editListVersions] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray(),
    db.editListVersions.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    projects: projects.map(stripRow),
    songs: songs.map(stripRow),
    sessions: sessions.map(stripRow),
    takes: takes.map(stripRow),
    picks: picks.map(stripRow),
    retakes: retakes.map(stripRow),
    editListVersions: editListVersions.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/**
 * 旧备份回填：v1 备份的场次没有 durationMin，按原时段补上默认时长；
 * 缺 editListVersions 字段的备份补空数组，不影响导入。
 */
function migrateSessionRow(row: Partial<Session>): Session {
  const durationMin =
    typeof row.durationMin === 'number' && Number.isFinite(row.durationMin) && row.durationMin > 0
      ? row.durationMin
      : PERIOD_DEFAULT_MINUTES[row.period as keyof typeof PERIOD_DEFAULT_MINUTES] ?? 480;
  return { ...(row as Session), durationMin };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes, db.editListVersions],
    async () => {
      await Promise.all([
        db.projects.clear(),
        db.songs.clear(),
        db.sessions.clear(),
        db.takes.clear(),
        db.picks.clear(),
        db.retakes.clear(),
        db.editListVersions.clear()
      ]);
      await db.projects.bulkPut(snapshot.projects.map(stamp));
      await db.songs.bulkPut(snapshot.songs.map(stamp));
      await db.sessions.bulkPut(snapshot.sessions.map(migrateSessionRow).map(stamp));
      await db.takes.bulkPut(snapshot.takes.map(stamp));
      await db.picks.bulkPut(snapshot.picks.map(stamp));
      await db.retakes.bulkPut(snapshot.retakes.map(stamp));
      await db.editListVersions.bulkPut((snapshot.editListVersions ?? []).map(stamp));
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes, db.editListVersions],
    async () => {
      await Promise.all([
        db.projects.clear(),
        db.songs.clear(),
        db.sessions.clear(),
        db.takes.clear(),
        db.picks.clear(),
        db.retakes.clear(),
        db.editListVersions.clear()
      ]);
    }
  );
  await seedDatabase(db);
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [projects, songs, sessions, takes, picks, retakes, editListVersions] = await Promise.all([
    db.projects.count(),
    db.songs.count(),
    db.sessions.count(),
    db.takes.count(),
    db.picks.count(),
    db.retakes.count(),
    db.editListVersions.count()
  ]);
  return { projects, songs, sessions, takes, picks, retakes, editListVersions };
}
