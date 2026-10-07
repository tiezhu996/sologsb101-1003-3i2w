<script setup lang="ts">
/**
 * /rescues 困人救援时间线
 * 录入报警 / 到场 / 救出时间，自动算响应时长并按电梯复盘；
 * 台账起点固定为「第一次报警时间」：事后补录到场 / 救出、勘误报警时间均不移动锚点，
 * 编辑必须填写改动说明，时间线列出改动前后时间，清单统计与 CSV 导出均按第一次报警算。
 */
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NForm,
  NFormItem,
  NGrid,
  NGi,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NText,
  NTimeline,
  NTimelineItem,
  NTooltip,
  useMessage,
  type DataTableColumns,
  type FormInst,
} from 'naive-ui';
import { useRescueStore, checkRescueDraft, RescueConflictError } from '../stores/rescueStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { ARRIVE_LIMIT_MINUTES, RESCUE_CAUSES, type RescueDraft, type RescueView } from '../types/rescue';
import { formatMinutes, todayDate } from '../utils/duration';
import { downloadCsv } from '../utils/export';
import StatBadge from '../components/common/StatBadge.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import FilterBar from '../components/common/FilterBar.vue';

const message = useMessage();
const rescueStore = useRescueStore();
const elevatorStore = useElevatorStore();

const keyword = ref('');
const elevatorFilters = ref<string[]>([]);
const activeFilter = ref<'all' | 'late'>('all');

const formRef = ref<FormInst | null>(null);
const modalOpen = ref(false);
const editingId = ref('');
/** 保存被拦截的冲突项（到场 / 救出早于第一次报警等） */
const conflictItems = ref<string[]>([]);
/** 非阻断提醒（超时、报警时间被改动） */
const warningItems = ref<string[]>([]);

interface RescueFormModel {
  elevatorId: string;
  alarmTs: number;
  /** null 表示事后尚未补录 */
  arriveTs: number | null;
  rescueTs: number | null;
  cause: string;
  trappedCount: number;
  responder: string;
  /** 改动说明，仅编辑时可填且必填 */
  changeNote: string;
}

const formModel = ref<RescueFormModel>({
  elevatorId: '',
  alarmTs: Date.now(),
  arriveTs: Date.now() + 20 * 60000,
  rescueTs: Date.now() + 45 * 60000,
  cause: RESCUE_CAUSES[0],
  trappedCount: 1,
  responder: '刘建国',
  changeNote: '',
});

onMounted(async () => {
  await rescueStore.bootstrap();
  await elevatorStore.bootstrap();
});

function onFilterChange(values: Record<string, string[]>): void {
  elevatorFilters.value = values.elevator ?? [];
}

const filtered = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return rescueStore.rescueViews.filter((row) => {
    if (elevatorFilters.value.length > 0 && !elevatorFilters.value.includes(row.elevatorId)) return false;
    if (activeFilter.value === 'late' && row.arriveStatus !== 'late') return false;
    if (lower && !`${row.elevatorName} ${row.cause} ${row.responder}`.toLowerCase().includes(lower)) return false;
    return true;
  });
});

const overview = computed(() => ({
  total: rescueStore.rescueViews.length,
  trapped: rescueStore.trappedTotal,
  avgRescue: rescueStore.averageRescueMinutes,
  avgArrive: rescueStore.averageArriveMinutes,
  onTimeRate: rescueStore.onTimeRate,
  late: rescueStore.lateArriveViews.length,
  pending: rescueStore.rescueViews.filter((item) => item.arriveStatus === 'pending').length,
}));

/** 到场时长中位数（仅已补录到场的事件） */
const medianRescue = computed(() => {
  const values = rescueStore.rescueViews
    .map((item) => item.rescueMinutes)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateTime(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** 编辑中事件的第一次报警锚点（创建时为空） */
const editingAnchor = computed(() => {
  if (!editingId.value) return '';
  return rescueStore.rescues.find((item) => item.id === editingId.value)?.firstAlarmAt ?? '';
});

function openCreate(): void {
  editingId.value = '';
  conflictItems.value = [];
  warningItems.value = [];
  formModel.value = {
    elevatorId: rescueStore.elevators[0]?.id ?? '',
    alarmTs: Date.now() - 300000,
    arriveTs: Date.now() + 15 * 60000,
    rescueTs: Date.now() + 40 * 60000,
    cause: RESCUE_CAUSES[0],
    trappedCount: 1,
    responder: '刘建国',
    changeNote: '',
  };
  modalOpen.value = true;
}

function openEdit(row: RescueView): void {
  editingId.value = row.id;
  conflictItems.value = [];
  warningItems.value = [];
  formModel.value = {
    elevatorId: row.elevatorId,
    alarmTs: new Date(row.alarmAt.replace(' ', 'T')).getTime(),
    arriveTs: row.arriveAt ? new Date(row.arriveAt.replace(' ', 'T')).getTime() : null,
    rescueTs: row.rescueAt ? new Date(row.rescueAt.replace(' ', 'T')).getTime() : null,
    cause: row.cause,
    trappedCount: row.trappedCount,
    responder: row.responder,
    changeNote: '',
  };
  modalOpen.value = true;
}

/** 表单内的实时时长预览（起点：编辑时为第一次报警时间，新建时为当前填写的报警时间） */
const previewAnchorTs = computed(() =>
  editingAnchor.value ? new Date(editingAnchor.value.replace(' ', 'T')).getTime() : formModel.value.alarmTs,
);
const previewArrive = computed(() =>
  formModel.value.arriveTs === null
    ? null
    : Math.max(0, Math.round((formModel.value.arriveTs - previewAnchorTs.value) / 60000)),
);
const previewRescue = computed(() =>
  formModel.value.rescueTs === null
    ? null
    : Math.max(0, Math.round((formModel.value.rescueTs - previewAnchorTs.value) / 60000)),
);

function buildDraft(): RescueDraft {
  return {
    elevatorId: formModel.value.elevatorId,
    alarmAt: toDateTime(formModel.value.alarmTs),
    arriveAt: formModel.value.arriveTs === null ? '' : toDateTime(formModel.value.arriveTs),
    rescueAt: formModel.value.rescueTs === null ? '' : toDateTime(formModel.value.rescueTs),
    cause: formModel.value.cause,
    trappedCount: formModel.value.trappedCount,
    responder: formModel.value.responder,
  };
}

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  const draft = buildDraft();
  const existing = editingId.value
    ? rescueStore.rescues.find((item) => item.id === editingId.value) ?? null
    : null;

  // 保存前按「第一次报警时间」校验：冲突项逐条列出并阻断
  const result = checkRescueDraft(existing, draft);
  conflictItems.value = result.ok ? [] : result.errors;
  warningItems.value = result.warnings;
  if (!result.ok) {
    message.error(`保存被拦截：${result.errors.length} 项时间冲突，请核对后重试`);
    return;
  }
  if (editingId.value && !formModel.value.changeNote.trim()) {
    conflictItems.value = ['请填写改动说明（事后补录或勘误原因）'];
    message.error(conflictItems.value[0]);
    return;
  }

  try {
    if (editingId.value) {
      const log = await rescueStore.updateRescue(editingId.value, draft, formModel.value.changeNote);
      if (log === null) {
        message.info('内容无变化，未生成改动记录');
      } else {
        message.success(`困人事件已更新，已记录 ${log.changes.length} 项改动`);
      }
    } else {
      await rescueStore.createRescue(draft);
      message.success(
        previewArrive.value !== null && previewArrive.value <= ARRIVE_LIMIT_MINUTES
          ? '困人事件已录入，到场及时'
          : previewArrive.value === null
            ? '困人事件已录入，到场时间待补录'
            : `困人事件已录入，到场超时 ${previewArrive.value - ARRIVE_LIMIT_MINUTES} 分钟，建议复盘`,
      );
    }
  } catch (cause) {
    // store 侧二次兜底（并发编辑等），同样逐条指出冲突项
    if (cause instanceof RescueConflictError) {
      conflictItems.value = cause.errors;
      message.error(`保存被拦截：${cause.errors.length} 项时间冲突`);
      return;
    }
    throw cause;
  }
  modalOpen.value = false;
}

/** 导出救援 CSV：时长 / 超时判定一律以第一次报警时间为起点 */
function exportRescueCsv(): void {
  const rows: Array<Array<string | number>> = [
    [
      '第一次报警时间',
      '当前报警时间',
      '电梯',
      '到场时间',
      '到场时长(分钟)',
      '到场判定',
      '救出时间',
      '救援时长(分钟)',
      '原因',
      '被困人数',
      '救援人',
      '改动次数',
    ],
    ...filtered.value.map((row) => [
      row.firstAlarmAt,
      row.alarmAt,
      row.elevatorName,
      row.arriveAt || '待补录',
      row.arriveMinutes ?? '待补录',
      row.arriveStatus === 'late'
        ? `超时（限${ARRIVE_LIMIT_MINUTES}分钟）`
        : row.arriveStatus === 'onTime'
          ? '按时'
          : '待补录',
      row.rescueAt || '待补录',
      row.rescueMinutes ?? '待补录',
      row.cause,
      row.trappedCount,
      row.responder,
      row.changes.length,
    ]),
  ];
  downloadCsv(`gbelevsvc-rescue-${todayDate()}.csv`, rows);
  message.success(`已导出 ${filtered.value.length} 起困人事件（按第一次报警时间统计）`);
}

const columns = computed<DataTableColumns<RescueView>>(() => [
  {
    title: '第一次报警时间',
    key: 'firstAlarmAt',
    width: 170,
    render: (row) =>
      h('div', { style: 'display:flex;align-items:center;gap:4px' }, [
        h('span', row.firstAlarmAt),
        row.alarmShifted
          ? h(
              NTooltip,
              { trigger: 'hover' },
              {
                trigger: () => h(NTag, { size: 'small', type: 'warning', round: true }, { default: () => '已改' }),
                default: () => `当前登记报警时间：${row.alarmAt}；统计仍以第一次报警为准`,
              },
            )
          : null,
      ]),
  },
  { title: '电梯', key: 'elevatorName', minWidth: 200, ellipsis: { tooltip: true } },
  {
    title: `到场时长（限${ARRIVE_LIMIT_MINUTES}分钟）`,
    key: 'arriveMinutes',
    width: 150,
    render: (row) => {
      if (row.arriveMinutes === null) {
        return h(NTag, { size: 'small', type: 'warning', round: true }, { default: () => '待补录' });
      }
      const minutes = row.arriveMinutes;
      return h(
        NTag,
        { size: 'small', type: row.arriveInTime ? 'success' : 'error', round: true },
        { default: () => `${formatMinutes(minutes)}${row.arriveInTime ? '' : ' 超时'}` },
      );
    },
  },
  {
    title: '救援时长',
    key: 'rescueMinutes',
    width: 120,
    render: (row) => (row.rescueMinutes === null ? '待补录' : formatMinutes(row.rescueMinutes)),
  },
  { title: '被困人数', key: 'trappedCount', width: 90 },
  { title: '原因', key: 'cause', minWidth: 130 },
  { title: '救援人', key: 'responder', width: 90 },
  {
    title: '改动',
    key: 'changes',
    width: 70,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.changes.length > 0 ? 'info' : 'default', round: true },
        { default: () => `${row.changes.length} 次` },
      ),
  },
  {
    title: '操作',
    key: 'actions',
    width: 170,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 2 }, {
        default: () => [
          h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => rescueStore.setActive(row.id) }, { default: () => '复盘' }),
          h(NButton, { size: 'tiny', text: true, onClick: () => openEdit(row) }, { default: () => '补录/编辑' }),
          h(
            NButton,
            {
              size: 'tiny',
              text: true,
              type: 'error',
              onClick: async () => {
                await rescueStore.deleteRescue(row.id);
                message.success('困人事件已删除');
              },
            },
            { default: () => '删除' },
          ),
        ],
      }),
  },
]);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">困人救援时间线</h2>
        <div class="page-sub">
          以第一次报警时间为台账起点：到场 / 救出可事后补录，报警时间勘误不移动起点，迟到不会被算成按时；右侧按电梯复盘。
        </div>
      </div>
      <n-space>
        <n-button @click="exportRescueCsv">导出救援 CSV</n-button>
        <n-button type="primary" @click="openCreate">录入困人事件</n-button>
      </n-space>
    </div>

    <div class="stat-grid">
      <stat-badge title="困人事件" :value="overview.total" suffix="起" color="#2080f0" />
      <stat-badge
        title="平均救援时长"
        :value="overview.avgRescue"
        suffix="分钟"
        color="#18a058"
        :hint="`中位数 ${formatMinutes(medianRescue)}，待补录不计入`"
      />
      <stat-badge
        title="平均到场时长"
        :value="overview.avgArrive"
        suffix="分钟"
        :color="overview.avgArrive <= ARRIVE_LIMIT_MINUTES ? '#18a058' : '#d03050'"
        :percent="overview.onTimeRate"
        hint="均自第一次报警算起，进度条为按时到场比例"
      />
      <stat-badge
        title="到场超时"
        :value="overview.late"
        suffix="起"
        :color="overview.late > 0 ? '#d03050' : '#18a058'"
        :hint="`累计被困 ${overview.trapped} 人 · 待补录 ${overview.pending} 起`"
      />
    </div>

    <filter-bar
      keyword-placeholder="按电梯 / 原因 / 救援人搜索"
      :selects="[
        {
          key: 'elevator',
          label: '电梯',
          options: elevatorStore.elevators.map((item) => ({ label: `${item.regCode}（${item.owner}）`, value: item.id })),
          width: 230,
        },
      ]"
      :result-count="filtered.length"
      count-unit="起事件"
      @update:keyword="(value: string) => (keyword = value)"
      @change="onFilterChange"
    >
      <n-button size="small" :type="activeFilter === 'late' ? 'error' : 'default'" @click="activeFilter = activeFilter === 'late' ? 'all' : 'late'">
        仅看到场超时（{{ overview.late }}）
      </n-button>
    </filter-bar>

    <n-grid :cols="3" :x-gap="14" class="section-gap">
      <n-gi :span="2">
        <n-card size="small" title="事件清单（时长自第一次报警算起）">
          <empty-panel
            v-if="filtered.length === 0"
            title="没有匹配的困人事件"
            description="可录入一起困人事件，或调整筛选条件。"
            create-label="录入困人事件"
            @create="openCreate"
          />
          <n-data-table
            v-else
            :columns="columns"
            :data="filtered"
            :bordered="false"
            size="small"
            :scroll-x="1200"
            :pagination="{ pageSize: 8 }"
            :row-class-name="(row: RescueView) => (row.arriveStatus === 'late' ? 'row-marked' : '')"
          />
        </n-card>
      </n-gi>

      <n-gi>
        <n-card size="small" title="按电梯复盘" style="margin-bottom: 14px">
          <n-space v-if="rescueStore.byElevator.length === 0" vertical>
            <n-text depth="3">暂无困人事件</n-text>
          </n-space>
          <n-space v-else vertical :size="10">
            <div v-for="group in rescueStore.byElevator" :key="group.elevatorId">
              <n-space justify="space-between" align="center">
                <n-text strong style="font-size: 13px">{{ group.elevatorName }}</n-text>
                <n-tag size="small" round>{{ group.count }} 起</n-tag>
              </n-space>
              <n-text depth="3" style="font-size: 12px">
                平均救援 {{ formatMinutes(group.averageRescueMinutes) }} · 累计被困 {{ group.trappedTotal }} 人
              </n-text>
            </div>
          </n-space>
        </n-card>

        <n-card size="small" :title="rescueStore.activeRescue ? `时间线回放 · ${rescueStore.activeRescue.elevatorName}` : '时间线回放'">
          <template v-if="rescueStore.activeRescue">
            <n-descriptions :column="1" size="small" label-placement="left" bordered>
              <n-descriptions-item label="第一次报警">
                {{ rescueStore.activeRescue.firstAlarmAt }}
                <n-tag v-if="rescueStore.activeRescue.alarmShifted" size="small" type="warning" round style="margin-left: 6px">
                  报警时间已改动
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="当前登记报警">{{ rescueStore.activeRescue.alarmAt }}</n-descriptions-item>
              <n-descriptions-item label="原因">{{ rescueStore.activeRescue.cause }}</n-descriptions-item>
              <n-descriptions-item label="被困人数">{{ rescueStore.activeRescue.trappedCount }} 人</n-descriptions-item>
              <n-descriptions-item label="救援人">{{ rescueStore.activeRescue.responder }}</n-descriptions-item>
            </n-descriptions>
            <n-timeline style="margin-top: 12px">
              <n-timeline-item
                v-for="(node, index) in rescueStore.activeRescue.timeline"
                :key="`${node.label}-${index}`"
                :type="
                  node.tone === 'alarm' || node.tone === 'anchor'
                    ? 'error'
                    : node.tone === 'arrive'
                      ? 'warning'
                      : node.tone === 'edit'
                        ? 'default'
                        : 'success'
                "
                :title="`${node.label} · ${node.at || '未录入'}`"
                :content="`${
                  node.minutesFromAlarm === null
                    ? node.tone === 'edit'
                      ? ''
                      : '待补录'
                    : node.minutesFromAlarm === 0
                      ? '报警起点'
                      : `距第一次报警 ${formatMinutes(node.minutesFromAlarm)}`
                }${node.detail ? ` · ${node.detail}` : ''}`"
              />
            </n-timeline>

            <template v-if="rescueStore.activeRescue.changes.length > 0">
              <n-divider style="margin: 10px 0">改动记录（改动前后）</n-divider>
              <n-space vertical :size="10">
                <div
                  v-for="(log, logIndex) in rescueStore.activeRescue.changes"
                  :key="`${log.at}-${logIndex}`"
                  class="change-log-box"
                >
                  <n-space justify="space-between" align="center">
                    <n-text strong style="font-size: 12.5px">{{ log.note }}</n-text>
                    <n-text depth="3" style="font-size: 12px">{{ log.at }}</n-text>
                  </n-space>
                  <div v-for="entry in log.changes" :key="entry.field" class="change-log-entry">
                    <n-tag size="small" :bordered="false" style="margin-right: 6px">{{ entry.label }}</n-tag>
                    <span class="change-before">{{ entry.before || '未录入' }}</span>
                    <span class="change-arrow">→</span>
                    <span class="change-after">{{ entry.after || '未录入（待补录）' }}</span>
                  </div>
                </div>
              </n-space>
            </template>
          </template>
          <n-text v-else depth="3">点击左侧事件行的「复盘」查看完整时间线</n-text>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 录入 / 补录 / 编辑 -->
    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId ? '补录 / 编辑困人事件' : '录入困人事件'"
      style="max-width: 600px"
    >
      <n-alert v-if="editingAnchor" type="info" :show-icon="false" style="margin-bottom: 12px">
        第一次报警时间：<b>{{ editingAnchor }}</b>。该时间为台账锚点不可修改；到场 / 救出错觉早于它将被拦截，统计也始终从它算起。
      </n-alert>
      <n-form ref="formRef" :model="formModel" label-placement="top">
        <n-form-item
          label="电梯"
          path="elevatorId"
          :rule="{ required: true, message: '请选择电梯', trigger: 'change' }"
        >
          <n-select
            v-model:value="formModel.elevatorId"
            filterable
            :options="elevatorStore.elevators.map((item) => ({ label: `${item.regCode}（${item.owner}）`, value: item.id }))"
          />
        </n-form-item>
        <n-grid :cols="3" :x-gap="10">
          <n-gi>
            <n-form-item :label="editingAnchor ? '报警时间（可勘误）' : '报警时间'" path="alarmTs">
              <n-date-picker v-model:value="formModel.alarmTs" type="datetime" clearable style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="到场时间（可事后补录）" path="arriveTs">
              <n-date-picker v-model:value="formModel.arriveTs" type="datetime" clearable style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="救出时间（可事后补录）" path="rescueTs">
              <n-date-picker v-model:value="formModel.rescueTs" type="datetime" clearable style="width: 100%" />
            </n-form-item>
          </n-gi>
        </n-grid>
        <n-grid :cols="2" :x-gap="12">
          <n-gi>
            <n-form-item label="原因" path="cause">
              <n-select
                v-model:value="formModel.cause"
                filterable
                tag
                :options="RESCUE_CAUSES.map((item) => ({ label: item, value: item }))"
              />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="被困人数" path="trappedCount">
              <n-input-number v-model:value="formModel.trappedCount" :min="1" :max="30" style="width: 100%" />
            </n-form-item>
          </n-gi>
        </n-grid>
        <n-form-item label="救援人" path="responder" :rule="{ required: true, message: '请输入救援人', trigger: 'blur' }">
          <n-input v-model:value="formModel.responder" />
        </n-form-item>

        <n-form-item v-if="editingId" label="改动说明（必填，例如：事后补录到场 / 接警时间勘误）" required>
          <n-input
            v-model:value="formModel.changeNote"
            type="textarea"
            :rows="2"
            placeholder="说明本次补录或改动的依据，保存后随事件长期留档"
          />
        </n-form-item>

        <n-space>
          <n-tag :type="previewArrive === null ? 'warning' : previewArrive <= ARRIVE_LIMIT_MINUTES ? 'success' : 'error'" round>
            到场 {{ previewArrive === null ? '待补录' : formatMinutes(previewArrive) }}
          </n-tag>
          <n-tag type="info" round>救出 {{ previewRescue === null ? '待补录' : formatMinutes(previewRescue) }}</n-tag>
          <n-tag round>限时 {{ ARRIVE_LIMIT_MINUTES }} 分钟</n-tag>
        </n-space>

        <n-alert
          v-if="conflictItems.length > 0"
          type="error"
          title="保存已拦截，请处理以下时间冲突"
          style="margin-top: 12px"
        >
          <ul style="margin: 0; padding-left: 18px">
            <li v-for="item in conflictItems" :key="item">{{ item }}</li>
          </ul>
        </n-alert>
        <n-alert v-if="warningItems.length > 0 && conflictItems.length === 0" type="warning" style="margin-top: 12px">
          <ul style="margin: 0; padding-left: 18px">
            <li v-for="item in warningItems" :key="item">{{ item }}</li>
          </ul>
        </n-alert>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="modalOpen = false">取消</n-button>
          <n-button type="primary" @click="submit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.change-log-box {
  border: 1px solid var(--n-border-color, #e8e8e8);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--n-color-target, #fafafa);
}
.change-log-entry {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.8;
}
.change-before {
  color: #d03050;
  text-decoration: line-through;
}
.change-arrow {
  margin: 0 6px;
  color: #909090;
}
.change-after {
  color: #18a058;
}
</style>
