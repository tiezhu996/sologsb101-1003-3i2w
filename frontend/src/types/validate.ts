/**
 * 跨表一致性校验：把「计划—保养项—整改单」之间的约束集中在一处，
 * 页面与 store 调用同一套规则，避免校验逻辑散落导致行为不一致。
 */
import type { CheckItemView, CheckResult } from './checkItem';
import { isAbnormal } from './checkItem';
import type { ElevatorView, MaintCycle } from './elevator';
import { CYCLE_DAYS } from '../utils/cycle';
import { isOverdueDate, parseDateTime } from '../utils/duration';
import { ARRIVE_LIMIT_MINUTES } from './rescue';

export interface ValidationResult {
  ok: boolean;
  /** 错误（阻断提交） */
  errors: string[];
  /** 警告（可继续，但提示复核） */
  warnings: string[];
}

/** 电梯档案校验：注册代码唯一性由调用方传入现有集合判断 */
export function validateElevator(
  draft: { regCode: string; owner: string; loadKg: number; stops: number; maintCycle: MaintCycle },
  existingCodes: string[],
  editingCode?: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!draft.regCode.trim()) errors.push('注册代码不能为空');
  const duplicated = existingCodes.filter((code) => code === draft.regCode.trim()).length > 1;
  if (duplicated && draft.regCode.trim() !== editingCode) warnings.push('存在相同注册代码，请确认是否为同一台设备');
  if (!draft.owner.trim()) errors.push('使用单位不能为空');
  if (draft.loadKg <= 0) errors.push('载重必须大于 0');
  if (draft.stops < 2) warnings.push('层站数小于 2，请确认是否为特殊梯型');
  if (draft.maintCycle === 'halfMonth' && draft.stops > 30) {
    warnings.push('层站数超过 30 层建议按季度周期维保并说明原因');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 保养项签署校验：全部项必须有结果 */
export function validateSign(items: CheckItemView[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (items.length === 0) {
    errors.push('该计划没有保养项，无法签署');
    return { ok: false, errors, warnings };
  }
  const unfilled = items.filter((item) => item.result === null);
  if (unfilled.length > 0) {
    errors.push(`还有 ${unfilled.length} 项未填写结果：${unfilled.slice(0, 3).map((item) => item.itemName).join('、')}`);
  }
  const abnormal = items.filter((item) => isAbnormal(item.result));
  if (abnormal.length > 0) {
    warnings.push(`存在 ${abnormal.length} 项异常 / 建议项，建议先转整改单再签署`);
  }
  const missingValue = items.filter((item) => item.result !== null && !item.value.trim());
  if (missingValue.length > 0) {
    warnings.push(`${missingValue.length} 项未填写实测值，建议补齐留档`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 判断某结果值是否为异常（对外暴露，供页面复用） */
export function resultIsAbnormal(result: CheckResult | null): boolean {
  return isAbnormal(result);
}

/** 救援时间线校验入参：firstAlarmAt 为第一次报警锚点，到场 / 救出允许空（事后补录） */
export interface RescueTimelineInput {
  firstAlarmAt: string;
  alarmAt: string;
  arriveAt: string;
  rescueAt: string;
}

/**
 * 困人救援时间线校验。
 * 口径固定：到场 / 救出必须不早于「第一次报警时间」，与当前登记的报警时间是否被改动无关——
 * 防止事后把报警时间往后改，使迟到记录被算成按时。
 */
export function validateRescueTimeline(input: RescueTimelineInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const first = parseDateTime(input.firstAlarmAt);
  const alarm = parseDateTime(input.alarmAt);
  const arrive = input.arriveAt ? parseDateTime(input.arriveAt) : null;
  const rescue = input.rescueAt ? parseDateTime(input.rescueAt) : null;

  if (Number.isNaN(first)) errors.push('第一次报警时间无效');
  if (!Number.isNaN(first) && !Number.isNaN(alarm) && alarm !== first) {
    warnings.push('当前报警时间与第一次报警时间不一致；时长与超时判定仍以第一次报警时间为准');
  }
  if (arrive !== null && !Number.isNaN(arrive) && !Number.isNaN(first) && arrive < first) {
    errors.push(`到场时间（${input.arriveAt}）早于第一次报警时间（${input.firstAlarmAt}）`);
  }
  if (rescue !== null && !Number.isNaN(rescue) && !Number.isNaN(first) && rescue < first) {
    errors.push(`救出时间（${input.rescueAt}）早于第一次报警时间（${input.firstAlarmAt}）`);
  }
  if (
    arrive !== null &&
    rescue !== null &&
    !Number.isNaN(arrive) &&
    !Number.isNaN(rescue) &&
    rescue < arrive
  ) {
    errors.push(`救出时间（${input.rescueAt}）早于到场时间（${input.arriveAt}）`);
  }
  if (
    arrive !== null &&
    !Number.isNaN(arrive) &&
    !Number.isNaN(first) &&
    arrive - first > ARRIVE_LIMIT_MINUTES * 60000
  ) {
    warnings.push(
      `按第一次报警时间算到场已超过 ${ARRIVE_LIMIT_MINUTES} 分钟时限，保存后该事件将计入超时复盘`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 整改限期校验 */
export function validateRectifyDue(dueDate: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!dueDate) errors.push('请选择整改限期');
  else if (isOverdueDate(dueDate)) warnings.push('整改限期已过期，登记后仍会显示超期预警');
  return { ok: errors.length === 0, errors, warnings };
}

/** 电梯卡片状态校验：汇总超期与整改情况，用于列表内联提示 */
export function elevatorStatusHint(view: ElevatorView): string {
  const parts: string[] = [];
  if (view.overduePlanCount > 0) parts.push(`${view.overduePlanCount} 期计划逾期`);
  if (view.pendingRectifyCount > 0) parts.push(`${view.pendingRectifyCount} 项待整改`);
  if (view.lastRescueMinutes !== null && view.lastRescueMinutes > 60) {
    parts.push(`最近救援耗时 ${view.lastRescueMinutes} 分钟，建议复盘`);
  }
  if (parts.length === 0) return `周期 ${CYCLE_DAYS[view.maintCycle]} 天，台账正常`;
  return parts.join('；');
}
