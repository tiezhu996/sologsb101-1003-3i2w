import type { Revisioned } from './persistence';

/** 困人事件原因字典 */
export const RESCUE_CAUSES = [
  '门锁回路故障',
  '停电困人',
  '变频器故障',
  '平层感应器失效',
  '钢丝绳打滑',
  '超载保护动作',
] as const;

/** 可补录 / 可修改的时间点字段名 */
export type RescueTimeField = 'alarmAt' | 'arriveAt' | 'rescueAt';

/** 时间字段中文标签（冲突提示与改动记录共用） */
export const RESCUE_TIME_FIELD_LABEL: Record<RescueTimeField, string> = {
  alarmAt: '报警时间',
  arriveAt: '到场时间',
  rescueAt: '救出时间',
};

/**
 * 单次改动记录：
 * 困人救援常有事后补录，时间会被多次修改，每次保存都留痕（持久化在记录上，重开仍在）。
 */
export interface RescueChangeEntry {
  /** 改动时间 */
  at: string;
  /** 改动说明 */
  note: string;
  /** 字段级改动前后值，未补录的补录场景 before 为 null */
  changes: Array<{
    field: RescueTimeField;
    label: string;
    before: string | null;
    after: string | null;
  }>;
}

/** 困人事件 */
export interface Rescue extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /**
   * 首次报警时间（不可变锚点）。
   * 复盘口径固定以第一次报警时间为起点；后续补录 / 修改只更新 alarmAt 等现值字段，
   * 不回写本字段，避免「报警时间往后改 → 迟到算按时」。
   */
  firstAlarmAt: string;
  /** 报警时间（现值，可能经事后修改） */
  alarmAt: string;
  /** 到场时间（事后补录前可为 null） */
  arriveAt: string | null;
  /** 救出时间（事后补录前可为 null） */
  rescueAt: string | null;
  /** 原因 */
  cause: string;
  /** 被困人数 */
  trappedCount: number;
  /** 救援人 */
  responder: string;
  /** 改动记录（时间线展示改动前后时间） */
  changes: RescueChangeEntry[];
  createdAt: string;
}

/** 困人事件草稿（新建 / 编辑表单提交） */
export interface RescueDraft {
  elevatorId: string;
  alarmAt: string;
  arriveAt: string | null;
  rescueAt: string | null;
  cause: string;
  trappedCount: number;
  responder: string;
  /** 改动说明：编辑保存时必填，用于事后补录 / 修改留痕 */
  changeNote?: string;
}

/** 时间线冲突项（保存校验返回） */
export interface RescueTimelineConflict {
  field: RescueTimeField;
  label: string;
  message: string;
}

/** 困人事件视图：以首次报警时间为锚点自动算到场与救援时长 */
export interface RescueView extends Rescue {
  elevatorName: string;
  owner: string;
  /** 首次报警 → 到场（分钟），未补录到场为 null */
  arriveMinutes: number | null;
  /** 首次报警 → 救出（分钟），未补录救出为 null */
  rescueMinutes: number | null;
  /** 报警时间是否被事后修改（现值晚于首次报警） */
  alarmMoved: boolean;
  /** 到场判定：timely 按时 / late 超时 / pending 尚未补录到场 */
  arriveState: 'timely' | 'late' | 'pending';
  /** 是否满足 30 分钟到场要求（未补录到场为 false，统计超时口径不把待补录算超时） */
  arriveInTime: boolean;
  /** 时间线节点（用于回放展示） */
  timeline: RescueTimelineNode[];
}

/** 时间线节点 */
export interface RescueTimelineNode {
  label: string;
  at: string | null;
  minutesFromAnchor: number | null;
  tone: 'alarm' | 'arrive' | 'rescue';
  detail: string;
  /** 该节点时间是否经事后修改 / 补录 */
  amended?: boolean;
}

/** 到场时限（分钟）：按特种设备应急要求 30 分钟内到场 */
export const ARRIVE_LIMIT_MINUTES = 30;
