/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 / 剪接确认版 分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session } from '../types/session';
import { ROOM_DAILY_CAPACITY_MIN, defaultMinutesOfPeriod } from '../types/session';
import type { Take } from '../types/take';
import type { Pick as PickModel, PickSnapshot } from '../types/pick';
import type { Retake } from '../types/retake';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import { assessPickList, buildPickSnapshotItems } from './pickList';

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
export type PickRow = PickModel & Revisioned;
export type RetakeRow = Retake & Revisioned;
export type PickSnapshotRow = PickSnapshot & Revisioned;

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;
  pickSnapshots!: Table<PickSnapshotRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版六张表
    this.version(1)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
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

    // v2：场次增加时长 durationMin；优选增加确认评级快照 snapshotGrade；新增剪接确认版表
    this.version(2)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt',
        pickSnapshots: 'id, confirmedAt'
      })
      .upgrade(async (tx) => {
        // 旧场次没有时长：按原时段回填
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.durationMin !== 'number' || !Number.isFinite(row.durationMin)) {
              row.durationMin = defaultMinutesOfPeriod(typeof row.period === 'string' ? row.period : undefined);
            }
            row.revision = ROW_REVISION;
          });

        // 旧优选没有评级快照：取当时所引 Take 的评级回填，并把当前清单整体视为一版已确认，
        // 这样升级不会凭空卡住导出；此后再改 Take 评级即立即失效
        const takeRows = (await tx.table('takes').toArray()) as TakeRow[];
        const takeGrade = new Map(takeRows.map((take) => [take.id, take.grade]));
        const legacyPicks = (await tx.table('picks').toArray()) as PickRow[];
        await tx
          .table('picks')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!('snapshotGrade' in row)) {
              row.snapshotGrade = takeGrade.get(row.takeId as string) ?? null;
            }
            row.revision = ROW_REVISION;
          });

        if (legacyPicks.length > 0) {
          const items = buildPickSnapshotItems(
            [...legacyPicks].sort((a, b) => a.order - b.order),
            takeRows
          );
          const now = Date.now();
          await tx.table('pickSnapshots').put({
            id: `pick-snapshot-v2-${now}`,
            confirmedAt: nowIso(),
            itemCount: items.length,
            items,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
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
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    const songs = await db.songs.where('projectId').equals(id).toArray();
    for (const song of songs) {
      await cascadeRemoveSong(song.id);
    }
    await db.projects.delete(id);
  });
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

export async function getSession(id: string): Promise<SessionRow | undefined> {
  return db.sessions.get(id);
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

/** 棚日容量校验结果：超出 480 分钟时返回挤占明细 */
export interface RoomCapacityCheck {
  roomNo: string;
  date: string;
  /** 含待保存场次在内的占用总时长（分钟） */
  usedMin: number;
  /** 剩余容量（分钟，负数即超时） */
  remainingMin: number;
  /** 挤占同棚当天容量的其它场次（已取消除外） */
  occupants: Array<{ session: SessionRow; songTitle: string }>;
}

type CapacityCandidate = {
  id?: string;
  roomNo: Session['roomNo'];
  date: Session['date'];
  durationMin: Session['durationMin'];
  state?: Session['state'];
};

/**
 * 校验某棚某天的场次总时长是否超过每日容量（480 分钟）。
 * 已取消的场次不计容量；待保存场次本身为「已取消」时直接放行。
 */
export async function checkRoomCapacity(
  candidate: CapacityCandidate,
  songs: SongRow[]
): Promise<RoomCapacityCheck | null> {
  if (candidate.state === '已取消') return null;
  const others = await db.sessions
    .where('roomNo')
    .equals(candidate.roomNo)
    .filter((item) => item.date === candidate.date && item.state !== '已取消' && item.id !== candidate.id)
    .toArray();
  const titleOf = (session: SessionRow): string =>
    songs.find((song) => song.id === session.songId)?.title ?? '曲目已删除';
  const usedMin = others.reduce((sum, item) => sum + (item.durationMin ?? defaultMinutesOfPeriod(item.period)), 0)
    + candidate.durationMin;
  const remainingMin = ROOM_DAILY_CAPACITY_MIN - usedMin;
  if (remainingMin >= 0) return null;
  return {
    roomNo: candidate.roomNo,
    date: candidate.date,
    usedMin,
    remainingMin,
    occupants: others.map((session) => ({ session, songTitle: titleOf(session) }))
  };
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
 * 修改 Take（评级一改，引用它的优选立即失效）。
 * snapshotGrade 只在「确认剪接清单」时刷新，这里不碰，因此评级变化后
 * pick.snapshotGrade !== take.grade，优选清单随即标记失效。
 */
export async function updateTake(id: string, patch: Partial<Take>): Promise<void> {
  await db.takes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 批量改评级：同单条修改，优选确认快照不会被动更新 */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<void> {
  await db.transaction('rw', [db.takes], async () => {
    for (const id of ids) {
      await db.takes.update(id, { grade, updatedAt: Date.now() } as never);
    }
  });
}

export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.takes, db.picks], async () => {
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/** 查询引用了指定 Take 的优选（评级改动时用于提示牵连失效的清单） */
export async function picksReferencingTakes(takeIds: string[]): Promise<PickRow[]> {
  if (takeIds.length === 0) return [];
  return db.picks.where('takeId').anyOf(takeIds).toArray();
}

/* ------------------------------ 优选 ------------------------------ */

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function putPick(row: PickRow): Promise<void> {
  await db.picks.put(row);
}

/** 新增优选写入：新行从未确认，snapshotGrade 为 null */
export async function updatePick(id: string, patch: Partial<PickModel>): Promise<void> {
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

/* --------------------------- 剪接清单确认版 --------------------------- */

export async function listPickSnapshots(): Promise<PickSnapshotRow[]> {
  const rows = await db.pickSnapshots.toArray();
  return rows.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
}

/**
 * 确认当前剪接清单：把各优选的评级快照刷新为 Take 当前评级，并冻结一版确认快照。
 * 返回确认版。评级改动后必须走这里重新确认，导出才会放行。
 */
export async function confirmPickList(): Promise<PickSnapshotRow> {
  return db.transaction('rw', [db.picks, db.pickSnapshots, db.takes], async () => {
    const [picks, takes] = await Promise.all([db.picks.toArray(), db.takes.toArray()]);
    const ordered = picks.sort((a, b) => a.order - b.order);
    const gradeOf = new Map(takes.map((take) => [take.id, take.grade]));
    const now = Date.now();
    for (const pick of ordered) {
      await db.picks.update(pick.id, {
        snapshotGrade: gradeOf.get(pick.takeId) ?? null,
        updatedAt: now
      } as never);
    }
    const items = buildPickSnapshotItems(ordered, takes);
    const row: PickSnapshotRow = {
      id: `pick-snapshot-${now}-${Math.random().toString(36).slice(2, 8)}`,
      confirmedAt: nowIso(),
      itemCount: items.length,
      items,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    };
    await db.pickSnapshots.put(row);
    return row;
  });
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
  picks: PickModel[];
  retakes: Retake[];
  pickSnapshots: PickSnapshot[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, songs, sessions, takes, picks, retakes, pickSnapshots] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray(),
    db.pickSnapshots.toArray()
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
    pickSnapshots: pickSnapshots.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/** 旧备份归一化：旧场次按时段补时长、旧优选补评级快照字段 */
function normalizeSnapshot(snapshot: DatabaseSnapshot): void {
  const gradeOf = new Map(snapshot.takes.map((take) => [take.id, take.grade]));
  snapshot.sessions.forEach((session) => {
    if (typeof (session as Partial<Session>).durationMin !== 'number') {
      session.durationMin = defaultMinutesOfPeriod(session.period);
    }
  });
  snapshot.picks.forEach((pick) => {
    const loose = pick as unknown as Record<string, unknown>;
    if (!('snapshotGrade' in loose)) {
      pick.snapshotGrade = gradeOf.get(pick.takeId) ?? null;
    }
  });
  if (!Array.isArray(snapshot.pickSnapshots)) snapshot.pickSnapshots = [];
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  normalizeSnapshot(snapshot);
  await db.transaction(
    'rw',
    [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes, db.pickSnapshots],
    async () => {
      await Promise.all([
        db.projects.clear(),
        db.songs.clear(),
        db.sessions.clear(),
        db.takes.clear(),
        db.picks.clear(),
        db.retakes.clear(),
        db.pickSnapshots.clear()
      ]);
      await db.projects.bulkPut(snapshot.projects.map(stamp));
      await db.songs.bulkPut(snapshot.songs.map(stamp));
      await db.sessions.bulkPut(snapshot.sessions.map(stamp));
      await db.takes.bulkPut(snapshot.takes.map(stamp));
      await db.picks.bulkPut(snapshot.picks.map(stamp));
      await db.retakes.bulkPut(snapshot.retakes.map(stamp));
      await db.pickSnapshots.bulkPut(snapshot.pickSnapshots.map(stamp));
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes, db.pickSnapshots],
    async () => {
      await Promise.all([
        db.projects.clear(),
        db.songs.clear(),
        db.sessions.clear(),
        db.takes.clear(),
        db.picks.clear(),
        db.retakes.clear(),
        db.pickSnapshots.clear()
      ]);
    }
  );
  await seedDatabase(db);
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [projects, songs, sessions, takes, picks, retakes, pickSnapshots] = await Promise.all([
    db.projects.count(),
    db.songs.count(),
    db.sessions.count(),
    db.takes.count(),
    db.picks.count(),
    db.retakes.count(),
    db.pickSnapshots.count()
  ]);
  return { projects, songs, sessions, takes, picks, retakes, pickSnapshots };
}

/**
 * 导出前闸口：剪接清单处于「已确认」状态才放行。
 * Take 评级修改导致优选失效、清单有结构改动或从未确认时，抛出带点名的错误。
 */
export async function assertPickListExportable(): Promise<void> {
  const [picks, takes, snapshots] = await Promise.all([
    listPicks(),
    listTakes(),
    listPickSnapshots()
  ]);
  const assessment = assessPickList(picks, takes, snapshots);
  if (assessment.status === 'confirmed' || assessment.status === 'empty') return;
  throw new Error(assessment.reason);
}
