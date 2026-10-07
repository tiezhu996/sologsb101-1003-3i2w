<script setup lang="ts">
/**
 * /rescues 困人救援时间线
 * 录入报警 / 到场 / 救出时间（到场、救出可事后补录），自动算响应时长并按电梯复盘；
 * 复盘口径固定以「首次报警时间」为起点：保存时拦截早于锚点的补录，
 * 时间线展示每次改动的前后时间，超时数 / 平均到场时长 / 导出均按此起点。
 * 消费 Rescue、Elevator 与 <FilterBar>、<StatBadge>。
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
  useMessage,
  type DataTableColumns,
  type FormInst,
} from 'naive-ui';
import { useRescueStore } from '../stores/rescueStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { ARRIVE_LIMIT_MINUTES, RESCUE_CAUSES, type RescueDraft, type RescueView } from '../types/rescue';
import { formatMinutes } from '../utils/duration';
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
/** 编辑时固定的首次报警锚点（用于表单内冲突提示） */
const editingAnchor = ref('');
/** 编辑保存前必填的改动说明 */
const changeNote = ref('');

interface RescueFormModel {
  elevatorId: string;
  alarmTs: number | null;
  arriveTs: number | null;
  rescueTs: number | null;
  cause: string;
  trappedCount: number;
  responder: string;
}

const formModel = ref<RescueFormModel>({
  elevatorId: '',
  alarmTs: Date.now(),
  arriveTs: Date.now() + 20 * 60000,
  rescueTs: Date.now() + 45 * 60000,
  cause: RESCUE_CAUSES[0],
  trappedCount: 1,
  responder: '刘建国',
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
    if (activeFilter.value === 'late' && row.arriveState !== 'late') return false;
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
  pending: rescueStore.rescueViews.filter((item) => item.arriveState === 'pending').length,
}));

/** 到场时长中位数（仅已补录到场，更能反映典型表现） */
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

function toDateTime(ts: number | null): string | null {
  if (ts === null) return null;
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function openCreate(): void {
  editingId.value = '';
  editingAnchor.value = '';
  changeNote.value = '';
  formModel.value = {
    elevatorId: rescueStore.elevators[0]?.id ?? '',
    alarmTs: Date.now() - 300000,
    arriveTs: null,
    rescueTs: null,
    cause: RESCUE_CAUSES[0],
    trappedCount: 1,
    responder: '刘建国',
  };
  modalOpen.value = true;
}

function openEdit(row: RescueView): void {
  editingId.value = row.id;
  editingAnchor.value = row.firstAlarmAt;
  changeNote.value = '';
  formModel.value = {
    elevatorId: row.elevatorId,
    alarmTs: new Date(row.alarmAt.replace(' ', 'T')).getTime(),
    arriveTs: row.arriveAt ? new Date(row.arriveAt.replace(' ', 'T')).getTime() : null,
    rescueTs: row.rescueAt ? new Date(row.rescueAt.replace(' ', 'T')).getTime() : null,
    cause: row.cause,
    trappedCount: row.trappedCount,
    responder: row.responder,
  };
  modalOpen.value = true;
}

/** 表单内的实时时长预览：始终以首次报警（编辑）/ 当前报警（新建）为起点 */
const anchorTs = computed(() =>
  editingId.value
    ? new Date(editingAnchor.value.replace(' ', 'T')).getTime()
    : (formModel.value.alarmTs ?? Number.NaN),
);
const previewArrive = computed(() => {
  if (formModel.value.arriveTs === null || !Number.isFinite(anchorTs.value)) return null;
  return Math.round((formModel.value.arriveTs - anchorTs.value) / 60000);
});
const previewRescue = computed(() => {
  if (formModel.value.rescueTs === null || !Number.isFinite(anchorTs.value)) return null;
  return Math.round((formModel.value.rescueTs - anchorTs.value) / 60000);
});

/** 表单实时冲突提示（保存拦截的前端预检，store 内还会再校验一次） */
const formConflicts = computed<string[]>(() => {
  const conflicts: string[] = [];
  const anchor = anchorTs.value;
  if (Number.isFinite(anchor)) {
    if (formModel.value.alarmTs !== null && formModel.value.alarmTs < anchor) {
      conflicts.push('报警时间不能早于首次报警时间（首次报警为固定复盘锚点）');
    }
    if (formModel.value.arriveTs !== null && formModel.value.arriveTs < anchor) {
      conflicts.push(`到场时间早于首次报警时间（${editingAnchor.value || toDateTime(anchor)}）`);
    }
    if (formModel.value.rescueTs !== null && formModel.value.rescueTs < anchor) {
      conflicts.push(`救出时间早于首次报警时间（${editingAnchor.value || toDateTime(anchor)}）`);
    }
  }
  if (
    formModel.value.arriveTs !== null &&
    formModel.value.rescueTs !== null &&
    formModel.value.rescueTs < formModel.value.arriveTs
  ) {
    conflicts.push('救出时间不能早于到场时间');
  }
  return conflicts;
});

/** 本次表单是否真的改动了字段（决定改动说明是否必填） */
const formDirty = computed(() => {
  const active = rescueStore.rescueViews.find((item) => item.id === editingId.value);
  if (!active) return true;
  return (
    active.elevatorId !== formModel.value.elevatorId ||
    toDateTime(formModel.value.alarmTs) !== active.alarmAt ||
    toDateTime(formModel.value.arriveTs) !== (active.arriveAt ?? null) ||
    toDateTime(formModel.value.rescueTs) !== (active.rescueAt ?? null) ||
    formModel.value.cause.trim() !== active.cause ||
    formModel.value.trappedCount !== active.trappedCount ||
    formModel.value.responder.trim() !== active.responder
  );
});

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (formModel.value.alarmTs === null) {
    message.error('请填写报警时间');
    return;
  }
  if (formConflicts.value.length > 0) {
    message.error(formConflicts.value[0]);
    return;
  }
  if (editingId.value && formDirty.value && !changeNote.value.trim()) {
    message.error('请填写改动说明（事后补录 / 修改必须留痕）');
    return;
  }
  const draft: RescueDraft = {
    elevatorId: formModel.value.elevatorId,
    alarmAt: toDateTime(formModel.value.alarmTs) ?? '',
    arriveAt: toDateTime(formModel.value.arriveTs),
    rescueAt: toDateTime(formModel.value.rescueTs),
    cause: formModel.value.cause,
    trappedCount: formModel.value.trappedCount,
    responder: formModel.value.responder.trim(),
    changeNote: changeNote.value,
  };
  if (editingId.value) {
    const result = await rescueStore.updateRescue(editingId.value, draft);
    if (!result.ok) {
      // 保存被拦住：逐项指出与首次报警锚点冲突的时间项
      message.error(`保存被拦截：${result.conflicts.map((item) => item.message).join('；')}`);
      return;
    }
    message.success('困人事件已更新，改动已记录');
  } else {
    const result = await rescueStore.createRescue(draft);
    if (!result.ok) {
      message.error(`保存被拦截：${result.conflicts.map((item) => item.message).join('；')}`);
      return;
    }
    message.success(
      previewArrive.value === null
        ? '困人事件已录入，到场 / 救出待补录'
        : previewArrive.value <= ARRIVE_LIMIT_MINUTES
          ? '困人事件已录入，到场及时'
          : `困人事件已录入，到场超时 ${previewArrive.value - ARRIVE_LIMIT_MINUTES} 分钟，建议复盘`,
    );
  }
  modalOpen.value = false;
}

/** 导出困人救援台账 CSV：时长 / 超时列一律以首次报警时间为起点 */
function exportCsv(): void {
  const rows: Array<Array<string | number>> = [
    [
      '首次报警时间',
      '报警登记时间',
      '到场时间',
      '救出时间',
      '电梯',
      '到场时长(分钟)',
      '到场判定',
      '救援时长(分钟)',
      '被困人数',
      '原因',
      '救援人',
      '改动次数',
    ],
  ];
  filtered.value.forEach((row) => {
    rows.push([
      row.firstAlarmAt,
      row.alarmAt,
      row.arriveAt ?? '',
      row.rescueAt ?? '',
      row.elevatorName,
      row.arriveMinutes ?? '',
      row.arriveState === 'pending' ? '待补录' : row.arriveState === 'late' ? '超时' : '按时',
      row.rescueMinutes ?? '',
      row.trappedCount,
      row.cause,
      row.responder,
      row.changes.length,
    ]);
  });
  downloadCsv('困人救援台账-按首次报警时间.csv', rows);
  message.success(`已导出 ${filtered.value.length} 起事件（口径：首次报警时间）`);
}

function formatLag(minutes: number | null): string {
  return minutes === null ? '待补录' : formatMinutes(minutes);
}

function formatChangeValue(value: string | null): string {
  return value ?? '未补录';
}

const columns = computed<DataTableColumns<RescueView>>(() => [
  {
    title: '首次报警时间',
    key: 'firstAlarmAt',
    width: 160,
    render: (row) =>
      h('div', { style: 'line-height:1.5' }, [
        h('div', null, row.firstAlarmAt),
        h(NText, { depth: 3, style: 'font-size:12px' }, {
          default: () => (row.alarmMoved ? `登记已改为 ${row.alarmAt}` : '计时起点'),
        }),
      ]),
  },
  { title: '电梯', key: 'elevatorName', minWidth: 200, ellipsis: { tooltip: true } },
  {
    title: '到场时长',
    key: 'arriveMinutes',
    width: 140,
    render: (row) =>
      row.arriveState === 'pending'
        ? h(NTag, { size: 'small', round: true }, { default: () => '待补录' })
        : h(
            NTag,
            { size: 'small', type: row.arriveState === 'late' ? 'error' : 'success', round: true },
            { default: () => `${formatMinutes(row.arriveMinutes ?? 0)}${row.arriveState === 'late' ? ' 超时' : ''}` },
          ),
  },
  {
    title: '救援时长',
    key: 'rescueMinutes',
    width: 120,
    render: (row) => formatLag(row.rescueMinutes),
  },
  { title: '被困人数', key: 'trappedCount', width: 90 },
  { title: '原因', key: 'cause', minWidth: 130 },
  { title: '救援人', key: 'responder', width: 90 },
  {
    title: '改动',
    key: 'changes',
    width: 80,
    render: (row) =>
      h(
        NTag,
        { size: 'small', round: true, type: row.changes.length > 0 ? 'warning' : 'default' },
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
          h(NButton, { size: 'tiny', text: true, onClick: () => openEdit(row) }, { default: () => row.arriveAt ? '编辑' : '补录' }),
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
          录入报警 / 到场 / 救出时间（可事后补录），时长、超时判定与导出一律以
          <n-text strong>第一次报警时间</n-text>
          为起点；报警时间被后改也不会移动锚点，避免迟到算成按时。
        </div>
      </div>
      <n-space>
        <n-button @click="exportCsv">导出 CSV</n-button>
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
        :hint="`中位数 ${formatMinutes(medianRescue)}，按首次报警起算`"
      />
      <stat-badge
        title="平均到场时长"
        :value="overview.avgArrive"
        suffix="分钟"
        :color="overview.avgArrive <= ARRIVE_LIMIT_MINUTES ? '#18a058' : '#d03050'"
        :percent="overview.onTimeRate"
        hint="按首次报警起算；进度条为按时到场比例"
      />
      <stat-badge
        title="到场超时"
        :value="overview.late"
        suffix="起"
        :color="overview.late > 0 ? '#d03050' : '#18a058'"
        :hint="`待补录到场 ${overview.pending} 起（不计超时）`"
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
        <n-card size="small" title="事件清单">
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
            :row-class-name="(row: RescueView) => (row.arriveState === 'late' ? 'row-marked' : '')"
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
            <n-alert type="info" :show-icon="false" style="margin-bottom: 10px">
              复盘起点固定为首次报警
              <n-text strong>{{ rescueStore.activeRescue.firstAlarmAt }}</n-text>
              <template v-if="rescueStore.activeRescue.alarmMoved">
                ；报警登记已改为 {{ rescueStore.activeRescue.alarmAt }}，时长不随之改动
              </template>
            </n-alert>
            <n-descriptions :column="1" size="small" label-placement="left" bordered>
              <n-descriptions-item label="原因">{{ rescueStore.activeRescue.cause }}</n-descriptions-item>
              <n-descriptions-item label="被困人数">{{ rescueStore.activeRescue.trappedCount }} 人</n-descriptions-item>
              <n-descriptions-item label="救援人">{{ rescueStore.activeRescue.responder }}</n-descriptions-item>
            </n-descriptions>
            <n-timeline style="margin-top: 12px">
              <n-timeline-item
                v-for="node in rescueStore.activeRescue.timeline"
                :key="node.label"
                :type="node.tone === 'alarm' ? 'error' : node.tone === 'arrive' ? 'warning' : 'success'"
                :title="`${node.label} · ${node.at ?? '待补录'}${node.amended ? '（已修改/补录）' : ''}`"
                :content="`${node.minutesFromAnchor === null ? '待补录' : node.minutesFromAnchor === 0 ? '计时起点' : `距首次报警 ${formatMinutes(node.minutesFromAnchor)}`} · ${node.detail}`"
              />
            </n-timeline>

            <n-divider style="margin: 14px 0 10px">改动记录（{{ rescueStore.activeRescue.changes.length }}）</n-divider>
            <n-space v-if="rescueStore.activeRescue.changes.length === 0" vertical>
              <n-text depth="3" style="font-size: 12px">暂无补录 / 修改记录</n-text>
            </n-space>
            <n-space v-else vertical :size="10">
              <div
                v-for="(entry, index) in [...rescueStore.activeRescue.changes].reverse()"
                :key="`${entry.at}-${index}`"
                class="change-entry"
              >
                <n-space justify="space-between" align="center">
                  <n-text strong style="font-size: 12px">第 {{ rescueStore.activeRescue.changes.length - index }} 次改动</n-text>
                  <n-text depth="3" style="font-size: 12px">{{ entry.at }}</n-text>
                </n-space>
                <div v-for="change in entry.changes" :key="change.field" class="change-line">
                  <n-tag size="tiny" round :type="change.before === null ? 'info' : 'warning'">
                    {{ change.before === null ? '补录' : '修改' }}{{ change.label }}
                  </n-tag>
                  <span class="change-time">{{ formatChangeValue(change.before) }}</span>
                  <n-text depth="3">→</n-text>
                  <span class="change-time">{{ formatChangeValue(change.after) }}</span>
                </div>
                <n-text depth="3" style="font-size: 12px">说明：{{ entry.note }}</n-text>
              </div>
            </n-space>
          </template>
          <n-text v-else depth="3">点击左侧事件行的「复盘」查看完整时间线</n-text>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 录入 / 编辑 -->
    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId ? '编辑困人事件（补录 / 修改）' : '录入困人事件'"
      style="max-width: 600px"
    >
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
        <n-alert v-if="editingId" type="warning" :show-icon="false" style="margin-bottom: 10px">
          首次报警时间 <n-text strong>{{ editingAnchor }}</n-text> 为固定计时起点，不可修改；
          补录的到场 / 救出时间若早于它，保存会被拦截。
        </n-alert>
        <n-grid :cols="3" :x-gap="10">
          <n-gi>
            <n-form-item label="报警时间（登记值）" path="alarmTs">
              <n-date-picker
                v-model:value="formModel.alarmTs"
                type="datetime"
                clearable
                style="width: 100%"
              />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="到场时间（可后补）" path="arriveTs">
              <n-date-picker
                v-model:value="formModel.arriveTs"
                type="datetime"
                clearable
                placeholder="清空=待补录"
                style="width: 100%"
              />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="救出时间（可后补）" path="rescueTs">
              <n-date-picker
                v-model:value="formModel.rescueTs"
                type="datetime"
                clearable
                placeholder="清空=待补录"
                style="width: 100%"
              />
            </n-form-item>
          </n-gi>
        </n-grid>
        <n-alert
          v-for="(conflict, index) in formConflicts"
          :key="index"
          type="error"
          :show-icon="false"
          style="margin-bottom: 8px"
        >
          {{ conflict }}
        </n-alert>
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
        <n-form-item
          v-if="editingId"
          label="改动说明（事后补录 / 修改必填，随记录永久保留）"
          path="changeNote"
        >
          <n-input
            v-model:value="changeNote"
            type="textarea"
            :rows="2"
            placeholder="例如：到场时间据班组签到记录补录；报警登记时间调整以监控首次报警为准"
          />
        </n-form-item>
        <n-space>
          <n-tag :type="previewArrive === null ? 'default' : previewArrive <= ARRIVE_LIMIT_MINUTES ? 'success' : 'error'" round>
            到场 {{ formatLag(previewArrive) }}
          </n-tag>
          <n-tag type="info" round>救出 {{ formatLag(previewRescue) }}</n-tag>
          <n-tag round>限时 {{ ARRIVE_LIMIT_MINUTES }} 分钟</n-tag>
          <n-tag v-if="editingId" round type="warning">均按首次报警 {{ editingAnchor }} 起算</n-tag>
        </n-space>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="modalOpen = false">取消</n-button>
          <n-button type="primary" :disabled="formConflicts.length > 0" @click="submit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.change-entry {
  padding: 8px 10px;
  border: 1px solid var(--n-border-color, #efeff5);
  border-radius: 6px;
  background: var(--n-color-target, #fafafc);
}

.change-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  margin: 4px 0;
}

.change-time {
  font-variant-numeric: tabular-nums;
}
</style>
