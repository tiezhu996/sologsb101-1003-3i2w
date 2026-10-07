/** 时长与超期计算：报警—到场—救出，超期天数与分钟/小时格式化 */
import {
  RESCUE_TIME_FIELD_LABEL,
  type RescueTimeField,
  type RescueTimelineConflict,
} from '../types/rescue';

/** "yyyy-MM-dd HH:mm" 解析为时间戳，非法输入返回 NaN */
export function parseDateTime(value: string): number {
  if (!value) return Number.NaN;
  const normalized = value.length <= 10 ? `${value}T00:00:00` : value.replace(' ', 'T');
  return new Date(normalized).getTime();
}

/** 两时间点间隔分钟数，非法输入或负值返回 0 */
export function minutesBetween(from: string, to: string): number {
  const start = parseDateTime(from);
  const end = parseDateTime(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const diff = Math.round((end - start) / 60000);
  return diff > 0 ? diff : 0;
}

/** 报警 → 到场分钟数 */
export function arriveMinutes(alarmAt: string, arriveAt: string): number {
  return minutesBetween(alarmAt, arriveAt);
}

/** 报警 → 救出分钟数 */
export function rescueMinutes(alarmAt: string, rescueAt: string): number {
  return minutesBetween(alarmAt, rescueAt);
}

/**
 * 两时间点间隔分钟数（可空版）：任一端未补录（null / 空串）返回 null。
 * 允许负数透传（不夹成 0），供冲突校验识别「补录时间早于锚点」。
 */
export function minutesBetweenNullable(
  from: string,
  to: string | null,
): number | null {
  if (!to) return null;
  const start = parseDateTime(from);
  const end = parseDateTime(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 60000);
}

/** 可空的报警 → 到场 / 救出分钟数，未补录返回 null */
export function lagMinutes(from: string, to: string | null): number | null {
  return minutesBetweenNullable(from, to);
}

/** 分钟格式化：不足 60 分钟显示分钟，否则显示小时+分钟 */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 分钟格式化为工时口径（用于统计均值） */
export function formatAverageMinutes(totalMinutes: number, count: number): string {
  if (count <= 0) return '—';
  return formatMinutes(Math.round(totalMinutes / count));
}

/** 相对今天的天数差（正数为已过去天数） */
export function daysFromToday(date: string, now: Date = new Date()): number {
  const at = parseDateTime(date.length <= 10 ? `${date} 23:59` : date);
  if (Number.isNaN(at)) return 0;
  return Math.floor((now.getTime() - at) / (24 * 3600 * 1000));
}

/** 是否超期 */
export function isOverdueDate(date: string, now: Date = new Date()): boolean {
  return daysFromToday(date, now) > 0;
}

/** 超期描述文案 */
export function overdueText(days: number): string {
  if (days <= 0) return '未超期';
  return `超期 ${days} 天`;
}

/** 今天日期 yyyy-MM-dd */
export function todayDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 当前时间 yyyy-MM-dd HH:mm */
export function nowDateTime(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${todayDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 时间线保存校验：所有时间点都不得早于「首次报警时间」这个固定锚点。
 *
 * 事后补录 / 修改时，现值 alarmAt 可能已经晚于 firstAlarmAt，但补录的到场、
 * 救出时间仍以第一次报警时间为准（不能跟着被往后改的报警时间走），
 * 否则迟到会被算成按时、复盘结论失真。
 *
 * @param anchor 首次报警时间 firstAlarmAt（新建时即当前填写的报警时间）
 * @param times  本次保存的报警 / 到场 / 救出时间（未补录传 null）
 * @returns 冲突项清单，空数组表示通过；调用方据此拦住保存并逐项指出冲突
 */
export function checkRescueTimeline(
  anchor: string,
  times: Partial<Record<RescueTimeField, string | null>>,
): RescueTimelineConflict[] {
  const anchorTs = parseDateTime(anchor);
  if (Number.isNaN(anchorTs)) return [];
  const conflicts: RescueTimelineConflict[] = [];
  (Object.keys(RESCUE_TIME_FIELD_LABEL) as RescueTimeField[]).forEach((field) => {
    const value = times[field];
    if (!value) return;
    const ts = parseDateTime(value);
    if (Number.isNaN(ts)) return;
    if (ts < anchorTs) {
      conflicts.push({
        field,
        label: RESCUE_TIME_FIELD_LABEL[field],
        message:
          field === 'alarmAt'
            ? `报警时间不能早于首次报警时间（${anchor}）；首次报警时间是固定复盘锚点，不随修改改动`
            : `${RESCUE_TIME_FIELD_LABEL[field]}（${value}）早于首次报警时间（${anchor}），请核对后再保存`,
      });
    }
  });
  // 救出还不能早于到场（到场未补录时跳过）
  if (times.arriveAt && times.rescueAt) {
    const arriveTs = parseDateTime(times.arriveAt);
    const rescueTs = parseDateTime(times.rescueAt);
    if (!Number.isNaN(arriveTs) && !Number.isNaN(rescueTs) && rescueTs < arriveTs) {
      conflicts.push({
        field: 'rescueAt',
        label: RESCUE_TIME_FIELD_LABEL.rescueAt,
        message: `救出时间（${times.rescueAt}）早于到场时间（${times.arriveAt}），请核对后再保存`,
      });
    }
  }
  return conflicts;
}
