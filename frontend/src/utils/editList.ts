/**
 * 剪接清单账：当前优选清单 ↔ 确认版的对账逻辑。
 * 评级一修改，引用该 Take 的清单立即失效；旧确认版以快照形式保留可查；
 * 重新确认前 assertExportReady 抛错，导出停住。
 */
import type { Pick } from '@/types/pick';
import type { Take } from '@/types/take';
import type {
  EditListEntrySnapshot,
  EditListInvalidRef,
  EditListState,
  EditListStatus,
  EditListVersion
} from '@/types/editList';

/** 当前清单中一条引用（顺序按 pick.order） */
interface CurrentRef {
  pick: Pick;
  take: Take | null;
}

function orderedRefs(picks: Pick[], takes: Take[]): CurrentRef[] {
  const takeById = new Map(takes.map((take) => [take.id, take]));
  return [...picks]
    .sort((a, b) => a.order - b.order)
    .map((pick) => ({ pick, take: takeById.get(pick.takeId) ?? null }));
}

/**
 * 当前清单签名：顺序 + 每条引用的 take / 用途 / 评级。
 * Take 评级一旦修改，签名立即与确认版不一致 → 清单失效。
 */
export function currentEditListSignature(picks: Pick[], takes: Take[]): string {
  return orderedRefs(picks, takes)
    .map(({ pick, take }) =>
      [pick.id, pick.order, pick.takeId, pick.usage, take ? take.grade : '__missing__'].join('|')
    )
    .join('||');
}

/** 判断某条引用相对确认版是否失效，未失效返回 null */
function invalidReason(ref: CurrentRef, confirmedAt: number): EditListInvalidRef | null {
  const { pick, take } = ref;
  if (!take) {
    return {
      pickId: pick.id,
      takeId: pick.takeId,
      takeNo: '已删除',
      reason: 'take-missing',
      reasonText: `优选 #${pick.order} 引用的 Take（${pick.takeId}）已删除`
    };
  }
  // 评级在确认之后被改过（含降级）：立即失效
  if (typeof take.gradeChangedAt === 'number' && take.gradeChangedAt > confirmedAt) {
    return {
      pickId: pick.id,
      takeId: take.id,
      takeNo: take.takeNo,
      reason: 'grade-changed',
      reasonText: `优选 #${pick.order} 引用的 ${take.takeNo} 评级在确认后被改为「${take.grade}」，剪接清单已失效`
    };
  }
  if (take.grade !== '可用') {
    return {
      pickId: pick.id,
      takeId: take.id,
      takeNo: take.takeNo,
      reason: 'grade-unusable',
      reasonText: `优选 #${pick.order} 引用的 ${take.takeNo} 当前评级为「${take.grade}」，不再是可用素材`
    };
  }
  return null;
}

/** 对当前优选清单与最新确认版 */
export function deriveEditListStatus(params: {
  picks: Pick[];
  takes: Take[];
  versions: EditListVersion[];
}): EditListStatus {
  const { picks, takes, versions } = params;
  const latest = [...versions].sort((a, b) => b.version - a.version)[0] ?? null;
  const refs = orderedRefs(picks, takes);

  if (!latest) {
    return {
      state: 'unconfirmed',
      latest: null,
      invalidRefs: [],
      message: '剪接清单尚未确认：确认后才能导出场次记录表。'
    };
  }

  const invalidRefs = refs
    .map((ref) => invalidReason(ref, latest.confirmedAt))
    .filter((item): item is EditListInvalidRef => item !== null);
  const signatureMatched = currentEditListSignature(picks, takes) === latest.signature;

  let state: EditListState;
  let message: string;
  if (invalidRefs.length === 0 && signatureMatched) {
    state = 'confirmed';
    message = `当前清单与确认版 v${latest.version} 一致，可以导出。`;
  } else if (invalidRefs.length > 0) {
    state = 'stale';
    message = `剪接清单已失效（${invalidRefs.length} 条引用受影响）：Take 评级修改后引用立即失效，旧确认版 v${latest.version} 仍可查，重新确认前导出停住。`;
  } else {
    state = 'stale';
    message = `当前清单与确认版 v${latest.version} 不一致（顺序或条目有调整），请重新确认后再导出。`;
  }
  return { state, latest, invalidRefs, message };
}

/** 生成确认版快照：只有全部引用仍可用时才能确认 */
export function buildEditListSnapshot(params: {
  picks: Pick[];
  takes: Take[];
  nextVersion: number;
  confirmedAt?: number;
}): EditListVersion {
  const { picks, takes } = params;
  const refs = orderedRefs(picks, takes);
  const problems = refs
    .map((ref) => {
      if (!ref.take) return `优选 #${ref.pick.order} 引用的 Take 已删除`;
      if (ref.take.grade !== '可用') return `优选 #${ref.pick.order} 的 ${ref.take.takeNo} 评级为「${ref.take.grade}」，不能进确认版`;
      return null;
    })
    .filter((item): item is string => item !== null);
  if (problems.length > 0) {
    throw new Error(`清单存在不可用引用，无法确认：${problems.join('；')}`);
  }
  const confirmedAt = params.confirmedAt ?? Date.now();
  const entries: EditListEntrySnapshot[] = refs.map(({ pick, take }) => ({
    pickId: pick.id,
    order: pick.order,
    usage: pick.usage,
    note: pick.note,
    takeId: pick.takeId,
    // 前面已保证 take 存在且可用
    takeNo: (take as Take).takeNo,
    startTc: (take as Take).startTc,
    endTc: (take as Take).endTc,
    grade: (take as Take).grade
  }));
  return {
    id: `el-${params.nextVersion}`,
    version: params.nextVersion,
    confirmedAt,
    entries,
    signature: currentEditListSignature(picks, takes)
  };
}

/** 导出闸门：未确认或已失效时抛错，导出场次记录表前必须通过 */
export function assertExportReady(status: EditListStatus): void {
  if (status.state === 'unconfirmed') {
    throw new Error('导出停住：剪接清单尚未确认，请先在优选页确认当前清单。');
  }
  if (status.state === 'stale') {
    const detail = status.invalidRefs.length > 0 ? `受影响引用：${status.invalidRefs.map((item) => item.reasonText).join('；')}` : '';
    throw new Error(`导出停住：${status.message}${detail ? ` ${detail}` : ''}`);
  }
}

/** 确认时间展示 YYYY-MM-DD HH:mm（UTC，与导出时间 exportedAt 口径一致） */
export function formatConfirmedAt(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}
