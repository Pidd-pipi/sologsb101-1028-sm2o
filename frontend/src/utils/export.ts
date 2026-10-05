/**
 * 场次记录表 JSON 序列化与校验
 * 补录页用于导出整份棚务记录，也是「导入导出备份」的数据校验入口。
 *
 * 导出闸口：Take 评级修改后，引用它的优选清单立即失效，未重新确认前
 * buildSessionSheet 会直接抛错，导出停住（旧确认版仍可在优选页查看）。
 */
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session } from '../types/session';
import type { Take } from '../types/take';
import type { Pick, PickSnapshot } from '../types/pick';
import type { Retake } from '../types/retake';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  assertPickListExportable,
  listPicks,
  listPickSnapshots,
  listProjects,
  listRetakes,
  listSessions,
  listSongs,
  listTakes
} from './db';
import { formatDuration, totalDuration } from './timecode';
import { nowIso } from './uuid';

/** 场次记录表中的一行 */
export interface SessionSheetRow {
  sessionId: string;
  date: string;
  period: string;
  /** 场次时长（分钟） */
  durationMin: number;
  roomNo: string;
  engineer: string;
  songTitle: string;
  projectName: string;
  takeCount: number;
  usableCount: number;
  pickedCount: number;
  durationText: string;
}

/** 场次记录表：导出给制作人与委托方存档 */
export interface SessionSheet {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  pickSnapshots: PickSnapshot[];
  retakes: Retake[];
  summary: {
    projectCount: number;
    songCount: number;
    sessionCount: number;
    takeCount: number;
    usableTakeCount: number;
    usableRatio: number;
    pickedCount: number;
    openRetakeCount: number;
    totalDurationText: string;
    /** 导出时剪接清单最近一次确认时间（未确认为 null） */
    pickConfirmedAt: string | null;
    rows: SessionSheetRow[];
  };
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number };

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as T;
}

/**
 * 汇总整份场次记录表。
 * 剪接清单未经确认（评级改动失效 / 有结构改动 / 从未确认）时抛出错误，调用方负责停住导出。
 */
export async function buildSessionSheet(): Promise<SessionSheet> {
  await assertPickListExportable();

  const [projects, songs, sessions, takes, picks, retakes, pickSnapshots] = await Promise.all([
    listProjects(),
    listSongs(),
    listSessions(),
    listTakes(),
    listPicks(),
    listRetakes(),
    listPickSnapshots()
  ]);

  const rows: SessionSheetRow[] = sessions.map((session) => {
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    const own = takes.filter((item) => item.sessionId === session.id);
    const ownIds = own.map((item) => item.id);
    return {
      sessionId: session.id,
      date: session.date,
      period: session.period,
      durationMin: session.durationMin,
      roomNo: session.roomNo,
      engineer: session.engineer,
      songTitle: song ? song.title : '曲目已删除',
      projectName: project ? project.name : '项目已删除',
      takeCount: own.length,
      usableCount: own.filter((item) => item.grade === '可用').length,
      pickedCount: picks.filter((item) => ownIds.includes(item.takeId)).length,
      durationText: formatDuration(totalDuration(own))
    };
  });

  const usable = takes.filter((item) => item.grade === '可用').length;

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    projects: projects.map(stripRevision),
    songs: songs.map(stripRevision),
    sessions: sessions.map(stripRevision),
    takes: takes.map(stripRevision),
    picks: picks.map(stripRevision),
    pickSnapshots: pickSnapshots.map(stripRevision),
    retakes: retakes.map(stripRevision),
    summary: {
      projectCount: projects.length,
      songCount: songs.length,
      sessionCount: sessions.length,
      takeCount: takes.length,
      usableTakeCount: usable,
      usableRatio: takes.length > 0 ? Math.round((usable / takes.length) * 100) : 0,
      pickedCount: picks.length,
      openRetakeCount: retakes.filter((item) => item.state !== '已完成').length,
      totalDurationText: formatDuration(totalDuration(takes)),
      pickConfirmedAt: pickSnapshots[0]?.confirmedAt ?? null,
      rows
    }
  };
}

export function serializeSheet(sheet: SessionSheet): string {
  return JSON.stringify(sheet, null, 2);
}

/** 校验并解析场次记录表 / 备份 JSON，失败时抛出可读错误 */
export function parseSheet(text: string): SessionSheet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('根节点必须是对象');
  }
  const candidate = parsed as Partial<SessionSheet>;
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段');
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段');
  if (!Array.isArray(candidate.takes)) throw new Error('takes 必须是数组');
  if (!Array.isArray(candidate.projects)) throw new Error('projects 必须是数组');
  return candidate as SessionSheet;
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
