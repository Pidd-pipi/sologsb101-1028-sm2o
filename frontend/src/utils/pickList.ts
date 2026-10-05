/**
 * 剪接清单确认状态判定（纯函数叶子模块）。
 * - Take 评级一旦修改，引用它的优选立即失效（snapshotGrade 与当前评级不一致）
 * - 工作清单与最近一次确认版存在任何结构差异（顺序 / 用途 / 备注 / 时间码 / 成员）也需重新确认
 * - 旧确认版由 PickSnapshot 留查，不参与「能否导出」判定
 */
import type { Pick, PickSnapshot, PickSnapshotItem } from '@/types/pick';
import type { Take } from '@/types/take';

export type PickListStatus = 'empty' | 'confirmed' | 'staleGrade' | 'drifted' | 'neverConfirmed';

export interface PickListAssessment {
  status: PickListStatus;
  /** 最近一次确认版（可能为 null） */
  latestSnapshot: PickSnapshot | null;
  /** 因评级改动而失效的优选（取前若干条，含 take 号用于点名） */
  gradeStale: Array<{ pick: Pick; take: Take | null; fromGrade: Pick['snapshotGrade']; toGrade: Take['grade'] | null }>;
  /** 引用的 Take 已被删除的优选 */
  missingTake: Pick[];
  /** 工作清单与确认版的结构差异说明 */
  driftReasons: string[];
  /** 面向用户的一句话结论 */
  reason: string;
}

function describeItem(item: PickSnapshotItem): string {
  return `#${item.order} ${item.takeNo}（${item.usage}）`;
}

/**
 * 评估当前优选清单相对最近确认版的状态。
 * @param picks 当前工作清单（已按 order 排序）
 * @param takes 全部 Take（查评级 / 时间码）
 * @param snapshots 历史确认版（按确认时间倒序，第一条为最新）
 */
export function assessPickList(
  picks: Pick[],
  takes: Take[],
  snapshots: PickSnapshot[]
): PickListAssessment {
  const latestSnapshot = snapshots[0] ?? null;
  const takeById = new Map(takes.map((take) => [take.id, take]));

  const gradeStale = picks
    .filter((pick) => {
      if (pick.snapshotGrade === null) return false;
      const take = takeById.get(pick.takeId);
      return take === undefined || take.grade !== pick.snapshotGrade;
    })
    .map((pick) => {
      const take = takeById.get(pick.takeId) ?? null;
      return { pick, take, fromGrade: pick.snapshotGrade, toGrade: take ? take.grade : null };
    });

  const missingTake = picks.filter((pick) => !takeById.has(pick.takeId));

  const driftReasons: string[] = [];
  if (latestSnapshot && picks.length === latestSnapshot.items.length && gradeStale.length === 0 && missingTake.length === 0) {
    latestSnapshot.items.forEach((frozen, index) => {
      const pick = picks[index];
      const take = takeById.get(pick.takeId);
      if (pick.id !== frozen.pickId) {
        driftReasons.push(`第 ${index + 1} 段已替换：${describeItem(frozen)} → 当前 #${pick.order} ${take ? take.takeNo : '条次已删除'}`);
        return;
      }
      if (pick.order !== frozen.order) driftReasons.push(`${describeItem(frozen)} 顺序变动`);
      if (pick.usage !== frozen.usage) driftReasons.push(`${describeItem(frozen)} 用途由「${frozen.usage}」改为「${pick.usage}」`);
      if (pick.note !== frozen.note) driftReasons.push(`${describeItem(frozen)} 备注已修改`);
      if (take) {
        if (take.startTc !== frozen.startTc || take.endTc !== frozen.endTc) {
          driftReasons.push(`${describeItem(frozen)} 时间码已修改（${frozen.startTc} → ${frozen.endTc} 改为 ${take.startTc} → ${take.endTc}）`);
        }
        if (take.takeNo !== frozen.takeNo) driftReasons.push(`${describeItem(frozen)} Take 号已改为 ${take.takeNo}`);
      }
    });
  } else if (latestSnapshot) {
    if (picks.length !== latestSnapshot.items.length) {
      driftReasons.push(`清单条数变化：确认版 ${latestSnapshot.items.length} 段 → 当前 ${picks.length} 段`);
    }
  }

  let status: PickListStatus;
  let reason: string;
  if (picks.length === 0) {
    status = 'empty';
    reason = '剪接清单为空';
  } else if (missingTake.length > 0) {
    status = 'drifted';
    reason = `${missingTake.length} 条优选引用的 Take 已删除，请重新整理并确认`;
  } else if (gradeStale.length > 0) {
    status = 'staleGrade';
    const names = gradeStale
      .slice(0, 5)
      .map((item) => `${item.take ? item.take.takeNo : '条次已删除'}（${item.fromGrade ?? '—'}→${item.toGrade ?? '已删除'}）`)
      .join('、');
    reason = `Take 评级已修改，引用它的优选立即失效：${names}${gradeStale.length > 5 ? ' 等' : ''}，重新确认前不能导出`;
  } else if (!latestSnapshot) {
    status = 'neverConfirmed';
    reason = '剪接清单尚未确认，确认前不能导出';
  } else if (driftReasons.length > 0) {
    status = 'drifted';
    reason = '清单自上次确认后已有改动，重新确认前不能导出';
  } else {
    status = 'confirmed';
    reason = '已确认，可导出';
  }

  return { status, latestSnapshot, gradeStale, missingTake, driftReasons, reason };
}

/** 把当前优选清单冻结为一版确认快照内容 */
export function buildPickSnapshotItems(picks: Pick[], takes: Take[]): PickSnapshotItem[] {
  const takeById = new Map(takes.map((take) => [take.id, take]));
  return picks.map((pick) => {
    const take = takeById.get(pick.takeId);
    return {
      pickId: pick.id,
      takeId: pick.takeId,
      takeNo: take ? take.takeNo : '条次已删除',
      startTc: take ? take.startTc : '',
      endTc: take ? take.endTc : '',
      grade: take ? take.grade : null,
      usage: pick.usage,
      order: pick.order,
      note: pick.note
    };
  });
}
