/**
 * 困人救援状态（Pinia）
 * 维护困人事件时间线与到场 / 救出时长派生值，并做响应时限判定。
 * 口径：所有时长、超时、统计均以「第一次报警时间」firstAlarmAt 为起点，
 * 事后补录到场 / 救出、勘误报警时间都不改锚点，改动逐条记录并持久化。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  listElevators,
  listRescues,
  putRescue,
  removeRescue,
  type ElevatorRow,
  type RescueRow,
} from '../utils/db';
import {
  ARRIVE_LIMIT_MINUTES,
  type RescueChangeEntry,
  type RescueChangeLog,
  type RescueDraft,
  type RescueTimelineNode,
  type RescueView,
} from '../types/rescue';
import { validateRescueTimeline, type ValidationResult } from '../types/validate';
import { arriveMinutes, nowDateTime, rescueMinutes } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

/** 编辑前校验（不写库）：保存拦截在页面与 store 共用同一套口径 */
export function checkRescueDraft(existing: RescueRow | null, draft: RescueDraft): ValidationResult {
  return validateRescueTimeline({
    firstAlarmAt: existing ? existing.firstAlarmAt : draft.alarmAt,
    alarmAt: draft.alarmAt,
    arriveAt: draft.arriveAt,
    rescueAt: draft.rescueAt,
  });
}

/** 保存被拦截时抛出，携带全部冲突项供页面逐条展示 */
export class RescueConflictError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors[0] ?? '救援时间存在冲突');
    this.name = 'RescueConflictError';
    this.errors = errors;
  }
}

/** 字段中文名映射（改动记录用） */
const FIELD_LABELS: Record<RescueChangeEntry['field'], string> = {
  alarmAt: '报警时间',
  arriveAt: '到场时间',
  rescueAt: '救出时间',
  cause: '原因',
  trappedCount: '被困人数',
  responder: '救援人',
  elevatorId: '电梯',
};

function diffEntries(before: RescueRow, draft: RescueDraft): RescueChangeEntry[] {
  const entries: Array<{ field: RescueChangeEntry['field']; before: string; after: string }> = [
    { field: 'alarmAt', before: before.alarmAt, after: draft.alarmAt },
    { field: 'arriveAt', before: before.arriveAt, after: draft.arriveAt },
    { field: 'rescueAt', before: before.rescueAt, after: draft.rescueAt },
    { field: 'cause', before: before.cause, after: draft.cause.trim() },
    { field: 'trappedCount', before: String(before.trappedCount), after: String(draft.trappedCount) },
    { field: 'responder', before: before.responder, after: draft.responder.trim() },
  ];
  return entries
    .filter((entry) => entry.before !== entry.after)
    .map((entry) => ({ ...entry, label: FIELD_LABELS[entry.field] }));
}

export const useRescueStore = defineStore('rescue', () => {
  const rescues = ref<RescueRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  /** 复盘选中的事件 */
  const activeRescueId = ref<string>('');
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rescueRows, elevatorRows] = await Promise.all([listRescues(), listElevators()]);
      rescues.value = rescueRows;
      elevators.value = elevatorRows;
      error.value = '';
      if (!activeRescueId.value || !rescueRows.some((item) => item.id === activeRescueId.value)) {
        activeRescueId.value = rescueRows[0]?.id ?? '';
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '困人事件读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!initialized.value) initialized.value = true;
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  async function createRescue(draft: RescueDraft): Promise<RescueRow> {
    // 首次创建：当前报警时间即第一次报警时间，锚点就此落定
    const result = checkRescueDraft(null, draft);
    if (!result.ok) throw new RescueConflictError(result.errors);
    const stamp = nowDateTime();
    const row: RescueRow = {
      id: uuid(),
      elevatorId: draft.elevatorId,
      firstAlarmAt: draft.alarmAt,
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
      cause: draft.cause.trim(),
      trappedCount: draft.trappedCount,
      responder: draft.responder.trim(),
      createdAt: stamp,
      revision: ROW_REVISION,
      changes: [],
    };
    await putRescue(row);
    activeRescueId.value = row.id;
    emitChange();
    return row;
  }

  /**
   * 编辑保存：
   * - 以不可变的 firstAlarmAt 做冲突校验，到场 / 救出早于第一次报警即拦截；
   * - note 为改动说明（事后补录 / 勘误原因），必填；
   * - 无字段变化时直接返回，不产生空改动记录。
   */
  async function updateRescue(id: string, draft: RescueDraft, note: string): Promise<RescueChangeLog | null> {
    const existing = rescues.value.find((item) => item.id === id);
    if (!existing) return null;
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new RescueConflictError(['请填写改动说明（事后补录或勘误原因）']);
    const result = checkRescueDraft(existing, draft);
    if (!result.ok) throw new RescueConflictError(result.errors);

    const entries = diffEntries(existing, draft);
    if (entries.length === 0) return null;

    const log: RescueChangeLog = { at: nowDateTime(), note: trimmedNote, changes: entries };
    // 历史改动记录来自响应式状态，展开成纯对象再入库，避免 Proxy 触发 IndexedDB 结构化克隆异常。
    // 注意：firstAlarmAt 永不回写，防止迟到被算成按时。
    const previousChanges: RescueChangeLog[] = (existing.changes ?? []).map((item) => ({
      at: item.at,
      note: item.note,
      changes: item.changes.map((entry) => ({ ...entry })),
    }));
    await putRescue({
      ...existing,
      elevatorId: draft.elevatorId,
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
      cause: draft.cause.trim(),
      trappedCount: draft.trappedCount,
      responder: draft.responder.trim(),
      changes: [log, ...previousChanges],
    });
    emitChange();
    return log;
  }

  async function deleteRescue(id: string): Promise<void> {
    await removeRescue(id);
    if (activeRescueId.value === id) activeRescueId.value = '';
    emitChange();
  }

  function setActive(id: string): void {
    activeRescueId.value = id;
  }

  /** 困人事件视图：以第一次报警时间算时长、时间线回放与改动记录 */
  const rescueViews = computed<RescueView[]>(() =>
    rescues.value.map((rescue) => {
      const elevator = elevators.value.find((item) => item.id === rescue.elevatorId);
      // 起点恒为第一次报警时间
      const arrive = arriveMinutes(rescue.firstAlarmAt, rescue.arriveAt);
      const total = rescueMinutes(rescue.firstAlarmAt, rescue.rescueAt);
      const arriveStatus: RescueView['arriveStatus'] =
        arrive === null ? 'pending' : arrive <= ARRIVE_LIMIT_MINUTES ? 'onTime' : 'late';
      const alarmShifted = rescue.alarmAt !== rescue.firstAlarmAt;

      const timeline: RescueTimelineNode[] = [];
      if (alarmShifted) {
        timeline.push({
          label: '第一次报警',
          at: rescue.firstAlarmAt,
          minutesFromAlarm: 0,
          tone: 'anchor',
          detail: '台账基准锚点，所有时长与超时判定以此为起点，不随后续改动变化',
        });
      }
      timeline.push({
        label: '接警',
        at: rescue.alarmAt,
        minutesFromAlarm: arriveMinutes(rescue.firstAlarmAt, rescue.alarmAt),
        tone: 'alarm',
        detail: alarmShifted
          ? `报警时间已被改动，第一次报警为 ${rescue.firstAlarmAt}；被困 ${rescue.trappedCount} 人`
          : `监控中心接到报警，被困 ${rescue.trappedCount} 人`,
      });
      timeline.push({
        label: '到场',
        at: rescue.arriveAt,
        minutesFromAlarm: arrive,
        tone: 'arrive',
        detail:
          arrive === null
            ? '事后补录：到场时间尚未补填'
            : arrive <= ARRIVE_LIMIT_MINUTES
              ? `按时到场（距第一次报警 ${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`
              : `到场超时（距第一次报警 ${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`,
      });
      timeline.push({
        label: '救出',
        at: rescue.rescueAt,
        minutesFromAlarm: total,
        tone: 'rescue',
        detail: rescue.rescueAt
          ? `原因：${rescue.cause}，救援人：${rescue.responder}`
          : '事后补录：救出时间尚未补填',
      });
      for (const log of rescue.changes ?? []) {
        timeline.push({
          label: '改动记录',
          at: log.at,
          minutesFromAlarm: null,
          tone: 'edit',
          detail: `${log.note}；${log.changes
            .map((entry) => `${entry.label}：${entry.before || '未录入'} → ${entry.after || '未录入'}`)
            .join('；')}`,
        });
      }

      return {
        ...rescue,
        changes: rescue.changes ?? [],
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        arriveMinutes: arrive,
        rescueMinutes: total,
        arriveStatus,
        arriveInTime: arriveStatus === 'onTime',
        alarmShifted,
        timeline,
      };
    }),
  );

  const activeRescue = computed(
    () => rescueViews.value.find((item) => item.id === activeRescueId.value) ?? null,
  );

  /** 已补录救出的事件视图（统计口径） */
  const completedViews = computed(() =>
    rescueViews.value.filter((item) => item.rescueMinutes !== null),
  );

  /** 平均救援时长（分钟，仅统计已补录救出的事件） */
  const averageRescueMinutes = computed(() => {
    if (completedViews.value.length === 0) return 0;
    const total = completedViews.value.reduce(
      (sum, item) => sum + (item.rescueMinutes ?? 0),
      0,
    );
    return Math.round(total / completedViews.value.length);
  });

  /** 平均到场时长（分钟，仅统计已补录到场的事件） */
  const averageArriveMinutes = computed(() => {
    const arrived = rescueViews.value.filter((item) => item.arriveMinutes !== null);
    if (arrived.length === 0) return 0;
    const total = arrived.reduce((sum, item) => sum + (item.arriveMinutes ?? 0), 0);
    return Math.round(total / arrived.length);
  });

  /** 到场超时事件（待补录不计超时） */
  const lateArriveViews = computed(() =>
    rescueViews.value.filter((item) => item.arriveStatus === 'late'),
  );

  /** 按电梯复盘分组（均值以第一次报警时间为起点、忽略未补录项） */
  const byElevator = computed(() => {
    const buckets = new Map<string, RescueView[]>();
    for (const view of rescueViews.value) {
      const list = buckets.get(view.elevatorId);
      if (list) list.push(view);
      else buckets.set(view.elevatorId, [view]);
    }
    return [...buckets.entries()]
      .map(([elevatorId, items]) => {
        const completed = items.filter((item) => item.rescueMinutes !== null);
        return {
          elevatorId,
          elevatorName: items[0]?.elevatorName ?? '-',
          count: items.length,
          averageRescueMinutes:
            completed.length === 0
              ? 0
              : Math.round(
                  completed.reduce((sum, item) => sum + (item.rescueMinutes ?? 0), 0) / completed.length,
                ),
          trappedTotal: items.reduce((sum, item) => sum + item.trappedCount, 0),
          items: items.sort((a, b) => b.firstAlarmAt.localeCompare(a.firstAlarmAt)),
        };
      })
      .sort((a, b) => b.count - a.count);
  });

  const trappedTotal = computed(() =>
    rescueViews.value.reduce((sum, item) => sum + item.trappedCount, 0),
  );

  /** 按时到场率：已补录到场的事件中按时的比例（待补录既不算准时也不算超时） */
  const onTimeRate = computed(() => {
    const arrived = rescueViews.value.filter((item) => item.arriveMinutes !== null);
    if (arrived.length === 0) return 0;
    const ok = arrived.filter((item) => item.arriveInTime).length;
    return Number(((ok / arrived.length) * 100).toFixed(1));
  });

  return {
    rescues,
    elevators,
    activeRescueId,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    createRescue,
    updateRescue,
    deleteRescue,
    setActive,
    rescueViews,
    activeRescue,
    completedViews,
    averageRescueMinutes,
    averageArriveMinutes,
    lateArriveViews,
    byElevator,
    trappedTotal,
    onTimeRate,
  };
});
