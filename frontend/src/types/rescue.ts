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

/** 救援时间字段标识（用于时间线与改动记录） */
export type RescueTimeField = 'alarmAt' | 'arriveAt' | 'rescueAt';

/** 单字段改动记录 */
export interface RescueChangeEntry {
  /** 字段标识；time 类型固定为三个时间字段 */
  field: RescueTimeField | 'cause' | 'trappedCount' | 'responder' | 'elevatorId';
  /** 字段中文名 */
  label: string;
  /** 改动前（时间为空表示当时尚未补录） */
  before: string;
  /** 改动后 */
  after: string;
}

/**
 * 一次编辑的改动记录。
 * 注意：firstAlarmAt（第一次报警时间）只在创建时落定，任何编辑都不允许修改，
 * 因此这里只记录「当前报警时间」被改成了什么，复盘统计始终以第一次报警为起点。
 */
export interface RescueChangeLog {
  /** 本次编辑时间 yyyy-MM-dd HH:mm */
  at: string;
  /** 改动说明（事后补录 / 勘误原因，必填） */
  note: string;
  /** 本次涉及的字段 */
  changes: RescueChangeEntry[];
}

/** 困人事件 */
export interface Rescue extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /**
   * 第一次报警时间 yyyy-MM-dd HH:mm。
   * 台账基准锚点：到场 / 救出时长、超时判定、统计与导出一律以它为起点，
   * 事后补录或勘误均不得回改，避免「把报警时间往后改、迟到变按时」。
   */
  firstAlarmAt: string;
  /** 报警时间（事后可勘误，允许与第一次报警时间不同，仅用于展示） */
  alarmAt: string;
  /** 到场时间；事后补录场景下初始为空字符串 */
  arriveAt: string;
  /** 救出时间；事后补录场景下初始为空字符串 */
  rescueAt: string;
  /** 原因 */
  cause: string;
  /** 被困人数 */
  trappedCount: number;
  /** 救援人 */
  responder: string;
  createdAt: string;
  /** 改动记录（按时间倒序保存，最新在前），随记录持久化，重开页面仍在 */
  changes: RescueChangeLog[];
}

/** 困人事件草稿 */
export interface RescueDraft {
  elevatorId: string;
  /** 报警时间（首次创建时同时落定为 firstAlarmAt） */
  alarmAt: string;
  /** 到场时间，空串表示尚未补录 */
  arriveAt: string;
  /** 救出时间，空串表示尚未补录 */
  rescueAt: string;
  cause: string;
  trappedCount: number;
  responder: string;
}

/** 到场状态：待补录 / 按时 / 超时（超时判定以第一次报警时间为起点） */
export type ArriveStatus = 'pending' | 'onTime' | 'late';

/** 困人事件视图：自动算到场与救援时长 */
export interface RescueView extends Rescue {
  elevatorName: string;
  owner: string;
  /** 第一次报警 → 到场（分钟）；到场未补录为 null */
  arriveMinutes: number | null;
  /** 第一次报警 → 救出（分钟）；救出未补录为 null */
  rescueMinutes: number | null;
  /** 到场状态（待补录 / 按时 / 超时） */
  arriveStatus: ArriveStatus;
  /** 是否满足 30 分钟到场要求；待补录不算准时也不算超时 */
  arriveInTime: boolean;
  /** 当前登记的报警时间是否与第一次报警时间不一致（事后被改动） */
  alarmShifted: boolean;
  /** 时间线节点（用于回放展示） */
  timeline: RescueTimelineNode[];
}

/** 时间线节点 */
export interface RescueTimelineNode {
  label: string;
  at: string;
  /** 距第一次报警的分钟数；null 表示该节点尚未补录 */
  minutesFromAlarm: number | null;
  tone: 'alarm' | 'arrive' | 'rescue' | 'edit' | 'anchor';
  detail: string;
}

/** 到场时限（分钟）：按特种设备应急要求 30 分钟内到场 */
export const ARRIVE_LIMIT_MINUTES = 30;
