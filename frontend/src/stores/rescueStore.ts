/**
 * 困人救援状态（Pinia）
 * 维护困人事件时间线与到场 / 救出时长派生值，并做响应时限判定。
 *
 * 复盘口径：一切时长、超时判定、统计与导出都以「首次报警时间 firstAlarmAt」为起点。
 * 事后补录到场 / 救出或修改报警时间都不会改动该锚点（防止迟到被算成按时），
 * 每次保存的改动前后值写入 changes，持久化在记录上、重开仍在。
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
  RESCUE_TIME_FIELD_LABEL,
  type RescueChangeEntry,
  type RescueDraft,
  type RescueTimelineConflict,
  type RescueTimelineNode,
  type RescueView,
  type RescueTimeField,
} from '../types/rescue';
import { checkRescueTimeline, lagMinutes, nowDateTime } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

/** 保存结果：存在冲突项时调用方拦住保存并逐项指出冲突 */
export interface RescueSaveResult {
  ok: boolean;
  conflicts: RescueTimelineConflict[];
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

  /** 新建：首次报警时间锚点 = 本次填写的报警时间，此后不可变 */
  async function createRescue(draft: RescueDraft): Promise<RescueSaveResult> {
    const conflicts = checkRescueTimeline(draft.alarmAt, {
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
    });
    if (conflicts.length > 0) return { ok: false, conflicts };
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
      changes: [],
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    await putRescue(row);
    activeRescueId.value = row.id;
    emitChange();
    return { ok: true, conflicts: [] };
  }

  /** 对比两个时间值（null 表示未补录） */
  function timeChanged(before: string | null, after: string | null): boolean {
    return (before ?? null) !== (after ?? null);
  }

  /**
   * 编辑保存（事后补录 / 修改）：
   * 1. 以不可变的首次报警时间为锚点做冲突校验，冲突则拦截；
   * 2. 记录改动前后时间与改动说明（重开后仍在）。
   */
  async function updateRescue(id: string, draft: RescueDraft): Promise<RescueSaveResult> {
    const existing = rescues.value.find((item) => item.id === id);
    if (!existing) return { ok: false, conflicts: [] };

    const conflicts = checkRescueTimeline(existing.firstAlarmAt, {
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
    });
    if (conflicts.length > 0) return { ok: false, conflicts };

    const timeFields: RescueTimeField[] = ['alarmAt', 'arriveAt', 'rescueAt'];
    const beforeTimes: Record<RescueTimeField, string | null> = {
      alarmAt: existing.alarmAt,
      arriveAt: existing.arriveAt,
      rescueAt: existing.rescueAt,
    };
    const afterTimes: Record<RescueTimeField, string | null> = {
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
    };
    const changedFields = timeFields.filter((field) =>
      timeChanged(beforeTimes[field], afterTimes[field]),
    );
    const metaChanged =
      existing.elevatorId !== draft.elevatorId ||
      existing.cause.trim() !== draft.cause.trim() ||
      existing.responder.trim() !== draft.responder.trim() ||
      existing.trappedCount !== draft.trappedCount;

    let changes = existing.changes;
    if (changedFields.length > 0 || metaChanged) {
      const entry: RescueChangeEntry = {
        at: nowDateTime(),
        note: draft.changeNote?.trim() || '未填写改动说明',
        changes: changedFields.map((field) => ({
          field,
          label: RESCUE_TIME_FIELD_LABEL[field],
          before: beforeTimes[field],
          after: afterTimes[field],
        })),
      };
      changes = [...existing.changes, entry];
    }

    await putRescue({
      ...existing,
      elevatorId: draft.elevatorId,
      // firstAlarmAt 不展开覆盖：首次报警时间永远保留
      firstAlarmAt: existing.firstAlarmAt,
      alarmAt: draft.alarmAt,
      arriveAt: draft.arriveAt,
      rescueAt: draft.rescueAt,
      cause: draft.cause.trim(),
      trappedCount: draft.trappedCount,
      responder: draft.responder.trim(),
      changes,
    });
    emitChange();
    return { ok: true, conflicts: [] };
  }

  async function deleteRescue(id: string): Promise<void> {
    await removeRescue(id);
    if (activeRescueId.value === id) activeRescueId.value = '';
    emitChange();
  }

  function setActive(id: string): void {
    activeRescueId.value = id;
  }

  /** 困人事件视图：以首次报警时间为锚点自动算时长、时间线回放节点 */
  const rescueViews = computed<RescueView[]>(() =>
    rescues.value.map((rescue) => {
      const elevator = elevators.value.find((item) => item.id === rescue.elevatorId);
      // 时长一律从首次报警时间起算，不看被修改过的现值 alarmAt
      const arrive = lagMinutes(rescue.firstAlarmAt, rescue.arriveAt);
      const total = lagMinutes(rescue.firstAlarmAt, rescue.rescueAt);
      const alarmMoved = rescue.alarmAt !== rescue.firstAlarmAt;
      const arriveState: RescueView['arriveState'] =
        arrive === null ? 'pending' : arrive <= ARRIVE_LIMIT_MINUTES ? 'timely' : 'late';
      const arriveInTime = arriveState === 'timely';

      const arriveDetail =
        arrive === null
          ? '到场时间待补录，暂不计入到场超时统计'
          : arrive <= ARRIVE_LIMIT_MINUTES
            ? `按时到场（距首次报警 ${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`
            : `到场超时（距首次报警 ${arrive} 分钟，限 ${ARRIVE_LIMIT_MINUTES} 分钟）`;
      const arriveAmended = rescue.changes.some((entry) =>
        entry.changes.some((change) => change.field === 'arriveAt'),
      );
      const rescueAmended = rescue.changes.some((entry) =>
        entry.changes.some((change) => change.field === 'rescueAt'),
      );

      const timeline: RescueTimelineNode[] = [
        {
          label: '首次报警',
          at: rescue.firstAlarmAt,
          minutesFromAnchor: 0,
          tone: 'alarm',
          detail: `监控中心接到报警，被困 ${rescue.trappedCount} 人（复盘固定起点）`,
        },
        {
          label: alarmMoved ? '报警登记（已修改）' : '接警登记',
          at: rescue.alarmAt,
          minutesFromAnchor: lagMinutes(rescue.firstAlarmAt, rescue.alarmAt),
          tone: 'alarm',
          amended: alarmMoved,
          detail: alarmMoved
            ? `报警登记时间被修改为 ${rescue.alarmAt}，时长仍按首次报警 ${rescue.firstAlarmAt} 起算`
            : '与首次报警时间一致',
        },
        {
          label: '到场',
          at: rescue.arriveAt,
          minutesFromAnchor: arrive,
          tone: 'arrive',
          amended: arriveAmended,
          detail: arriveDetail,
        },
        {
          label: '救出',
          at: rescue.rescueAt,
          minutesFromAnchor: total,
          tone: 'rescue',
          amended: rescueAmended,
          detail:
            total === null
              ? '救出时间待补录'
              : `距首次报警 ${total} 分钟；原因：${rescue.cause}，救援人：${rescue.responder}`,
        },
      ];
      return {
        ...rescue,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        arriveMinutes: arrive,
        rescueMinutes: total,
        alarmMoved,
        arriveState,
        arriveInTime,
        timeline,
      };
    }),
  );

  const activeRescue = computed(
    () => rescueViews.value.find((item) => item.id === activeRescueId.value) ?? null,
  );

  /** 已补录救出的视图（未补录不参与均值） */
  const completedViews = computed(
    () => rescueViews.value.filter((item) => item.rescueMinutes !== null),
  );
  /** 已补录到场的视图（待补录不参与到场统计） */
  const arriveConfirmedViews = computed(
    () => rescueViews.value.filter((item) => item.arriveState !== 'pending'),
  );

  /** 平均救援时长（分钟，仅统计已补录救出的事件） */
  const averageRescueMinutes = computed(() => {
    if (completedViews.value.length === 0) return 0;
    const total = completedViews.value.reduce((sum, item) => sum + (item.rescueMinutes ?? 0), 0);
    return Math.round(total / completedViews.value.length);
  });

  /** 平均到场时长（分钟，以首次报警为起点，仅统计已补录到场的事件） */
  const averageArriveMinutes = computed(() => {
    if (arriveConfirmedViews.value.length === 0) return 0;
    const total = arriveConfirmedViews.value.reduce(
      (sum, item) => sum + (item.arriveMinutes ?? 0),
      0,
    );
    return Math.round(total / arriveConfirmedViews.value.length);
  });

  /** 到场超时事件（待补录不算超时） */
  const lateArriveViews = computed(
    () => rescueViews.value.filter((item) => item.arriveState === 'late'),
  );

  /** 按电梯复盘分组 */
  const byElevator = computed(() => {
    const buckets = new Map<string, RescueView[]>();
    for (const view of rescueViews.value) {
      const list = buckets.get(view.elevatorId);
      if (list) list.push(view);
      else buckets.set(view.elevatorId, [view]);
    }
    return [...buckets.entries()]
      .map(([elevatorId, items]) => {
        const done = items.filter((item) => item.rescueMinutes !== null);
        return {
          elevatorId,
          elevatorName: items[0]?.elevatorName ?? '-',
          count: items.length,
          averageRescueMinutes:
            done.length === 0
              ? 0
              : Math.round(
                  done.reduce((sum, item) => sum + (item.rescueMinutes ?? 0), 0) / done.length,
                ),
          trappedTotal: items.reduce((sum, item) => sum + item.trappedCount, 0),
          // 组内按首次报警时间倒序
          items: items.sort((a, b) => b.firstAlarmAt.localeCompare(a.firstAlarmAt)),
        };
      })
      .sort((a, b) => b.count - a.count);
  });

  const trappedTotal = computed(() =>
    rescueViews.value.reduce((sum, item) => sum + item.trappedCount, 0),
  );

  /** 按时到场率：分母只含已补录到场的事件，待补录不参与 */
  const onTimeRate = computed(() => {
    if (arriveConfirmedViews.value.length === 0) return 0;
    const ok = arriveConfirmedViews.value.filter((item) => item.arriveInTime).length;
    return Number(((ok / arriveConfirmedViews.value.length) * 100).toFixed(1));
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
    averageRescueMinutes,
    averageArriveMinutes,
    lateArriveViews,
    byElevator,
    trappedTotal,
    onTimeRate,
    ARRIVE_LIMIT_MINUTES,
  };
});
