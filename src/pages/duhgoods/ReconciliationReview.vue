<template>
  <div class="h-screen overflow-hidden flex flex-col" style="width: var(--w-desk)">
    <PageHeader :title="t`مراجعة التسوية`">
      <Button :label="t`تحديث`" @click="loadMatches" :loading="loading" />
    </PageHeader>

    <div class="flex-1 overflow-auto dark:bg-gray-875" dir="rtl">
      <!-- Filter tabs -->
      <div class="flex gap-1 p-3 border-b dark:border-gray-700">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          @click="activeTab = tab.value"
          class="px-3 py-1 rounded text-sm font-medium"
          :class="activeTab === tab.value ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
        >
          {{ tab.label }} ({{ tabCount(tab.value) }})
        </button>
      </div>

      <!-- Match list -->
      <div class="divide-y dark:divide-gray-700">
        <div
          v-for="match in filteredMatches"
          :key="match.name"
          class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div class="flex justify-between items-start gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <ConfidenceBadge :confidence="match.confidence" />
                <StatusBadge :status="match.status" />
                <span class="text-xs text-gray-500 dark:text-gray-400">
                  <bdi dir="ltr">{{ match.name }}</bdi>
                </span>
              </div>

              <div class="grid grid-cols-2 gap-2 text-sm">
                <EvidenceCard :record="match.leftRecord" :label="t`السجل الأول`" />
                <EvidenceCard :record="match.rightRecord" :label="t`السجل الثاني`" />
              </div>

              <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <span>{{ t`فارق المبلغ` }}: <bdi dir="ltr">{{ formatMoney(match.amountDelta) }}</bdi></span>
                <span class="mx-2">|</span>
                <span>{{ t`فارق الأيام` }}: <bdi dir="ltr">{{ match.dateDeltaDays }}</bdi></span>
              </div>

              <div v-if="match.reasonCodes" class="mt-1 text-xs">
                <span class="text-gray-400">{{ t`أسباب المطابقة` }}: </span>
                <span v-for="code in parseReasonCodes(match.reasonCodes)" :key="code" class="inline-block mx-1 px-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-300">{{ code }}</span>
              </div>
            </div>

            <!-- Actions -->
            <div v-if="match.status === 'proposed'" class="flex gap-2 shrink-0">
              <Button
                :label="t`قبول`"
                type="primary"
                size="small"
                :loading="actioning === match.name + ':accept'"
                @click="acceptMatch(match.name)"
              />
              <Button
                :label="t`رفض`"
                type="danger"
                size="small"
                :loading="actioning === match.name + ':reject'"
                @click="rejectMatch(match.name)"
              />
            </div>
            <div v-else-if="match.status === 'accepted'" class="text-green-600 text-sm shrink-0">
              ✓ {{ t`مقبول` }}
            </div>
            <div v-else-if="match.status === 'rejected'" class="text-red-600 text-sm shrink-0">
              ✗ {{ t`مرفوض` }}
            </div>
          </div>

          <div v-if="decisionNote[match.name] !== undefined" class="mt-2">
            <input
              type="text"
              v-model="decisionNote[match.name]"
              :placeholder="t`ملاحظة القرار (اختياري)`"
              class="w-full border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            />
            <div class="flex gap-2 mt-1 justify-end">
              <Button size="small" :label="t`تأكيد الرفض`" type="danger" @click="confirmReject(match.name)" />
              <Button size="small" :label="t`إلغاء`" @click="cancelDecision(match.name)" />
            </div>
          </div>
        </div>

        <div v-if="filteredMatches.length === 0" class="p-8 text-center text-gray-400 dark:text-gray-500">
          {{ t`لا توجد مطابقات في هذا التصنيف` }}
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted } from 'vue';
import { t } from 'fyo';
import PageHeader from 'src/components/PageHeader.vue';
import Button from 'src/components/Button.vue';
import { fyo } from 'src/initFyo';
import { ModelNameEnum } from 'models/types';
import { DuhGoodsReconciliationService } from 'duhgoods/reconciliation/ReconciliationService';

interface MatchRow {
  name: string;
  status: string;
  confidence: string;
  leftRecord: Record<string, unknown>;
  rightRecord: Record<string, unknown>;
  amountDelta: unknown;
  dateDeltaDays: number;
  reasonCodes: string;
}

const ConfidenceBadge = defineComponent({
  name: 'ConfidenceBadge',
  props: { confidence: String },
  setup(props) {
    const colorClass = computed(() => {
      switch (props.confidence) {
        case 'exact': return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
        case 'high': return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
        case 'medium': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300';
        default: return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
      }
    });
    const label = computed(() => {
      const map: Record<string, string> = { exact: 'دقيق', high: 'عالي', medium: 'متوسط', low: 'منخفض' };
      return map[props.confidence ?? ''] ?? props.confidence;
    });
    return { colorClass, label };
  },
  template: `<span class="px-2 py-0.5 rounded text-xs font-medium" :class="colorClass">{{ label }}</span>`,
});

const StatusBadge = defineComponent({
  name: 'StatusBadge',
  props: { status: String },
  setup(props) {
    const colorClass = computed(() => {
      switch (props.status) {
        case 'proposed': return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
        case 'accepted': return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
        case 'rejected': return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
        default: return 'bg-gray-100 text-gray-600';
      }
    });
    const label = computed(() => {
      const map: Record<string, string> = { proposed: 'مقترح', accepted: 'مقبول', rejected: 'مرفوض', superseded: 'مستبدل' };
      return map[props.status ?? ''] ?? props.status;
    });
    return { colorClass, label };
  },
  template: `<span class="px-2 py-0.5 rounded text-xs" :class="colorClass">{{ label }}</span>`,
});

const EvidenceCard = defineComponent({
  name: 'EvidenceCard',
  props: {
    record: { type: Object as () => Record<string, unknown>, default: null },
    label: String,
  },
  setup(props) {
    const txTypeLabel = computed(() => {
      const map: Record<string, string> = {
        order: 'طلب', payment: 'دفع', refund: 'استرداد', fee: 'رسوم',
        settlement: 'تسوية', chargeback: 'استرداد قسري', bank_credit: 'إيداع بنكي', bank_debit: 'سحب بنكي',
      };
      return map[props.record?.transactionType as string] ?? props.record?.transactionType;
    });
    return { txTypeLabel };
  },
  template: `
    <div class="border rounded p-2 dark:border-gray-700 dark:bg-gray-800">
      <div class="text-xs text-gray-400 mb-1">{{ label }}</div>
      <div v-if="record">
        <div class="font-medium text-xs"><bdi dir="ltr">{{ record.name }}</bdi></div>
        <div class="text-xs text-gray-600 dark:text-gray-400">{{ txTypeLabel }} · {{ record.currency }}</div>
        <div class="text-sm font-mono"><bdi dir="ltr">{{ record.netAmount }}</bdi></div>
      </div>
      <div v-else class="text-xs text-gray-400">—</div>
    </div>
  `,
});

export default defineComponent({
  name: 'ReconciliationReview',
  components: { PageHeader, Button, ConfidenceBadge, StatusBadge, EvidenceCard },
  setup() {
    const loading = ref(false);
    const actioning = ref('');
    const matches = ref<MatchRow[]>([]);
    const decisionNote = ref<Record<string, string>>({});
    const activeTab = ref('proposed');

    const tabs = [
      { label: t`مقترح`, value: 'proposed' },
      { label: t`مقبول`, value: 'accepted' },
      { label: t`مرفوض`, value: 'rejected' },
    ];

    const filteredMatches = computed(() =>
      matches.value.filter((m) => m.status === activeTab.value)
    );

    const tabCount = (status: string) =>
      matches.value.filter((m) => m.status === status).length;

    const loadMatches = async () => {
      loading.value = true;
      try {
        const rows = await fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
          fields: ['name', 'status', 'confidence', 'leftRecord', 'rightRecord', 'amountDelta', 'dateDeltaDays', 'reasonCodes', 'leftEvidenceHash', 'rightEvidenceHash'],
          orderBy: 'matchedAt',
          order: 'desc',
        });

        // Load left/right record details
        const result: MatchRow[] = [];
        for (const row of rows) {
          const [left, right] = await Promise.all([
            fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, row.leftRecord as string).catch(() => ({})),
            fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, row.rightRecord as string).catch(() => ({})),
          ]);
          result.push({
            name: row.name as string,
            status: row.status as string,
            confidence: row.confidence as string,
            leftRecord: { ...left as object, name: row.leftRecord },
            rightRecord: { ...right as object, name: row.rightRecord },
            amountDelta: row.amountDelta,
            dateDeltaDays: (row.dateDeltaDays as number) ?? 0,
            reasonCodes: (row.reasonCodes as string) ?? '[]',
          });
        }
        matches.value = result;
      } finally {
        loading.value = false;
      }
    };

    const acceptMatch = async (matchName: string) => {
      actioning.value = matchName + ':accept';
      try {
        const svc = new DuhGoodsReconciliationService(fyo);
        await svc.accept(matchName, 'user');
        await loadMatches();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        actioning.value = '';
      }
    };

    const rejectMatch = (matchName: string) => {
      decisionNote.value[matchName] = '';
    };

    const confirmReject = async (matchName: string) => {
      actioning.value = matchName + ':reject';
      try {
        const svc = new DuhGoodsReconciliationService(fyo);
        await svc.reject(matchName, 'user', decisionNote.value[matchName]);
        delete decisionNote.value[matchName];
        await loadMatches();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        actioning.value = '';
      }
    };

    const cancelDecision = (matchName: string) => {
      delete decisionNote.value[matchName];
    };

    const parseReasonCodes = (codes: string): string[] => {
      try { return JSON.parse(codes); } catch { return [codes]; }
    };

    const formatMoney = (val: unknown): string => {
      if (val == null) return '0';
      try { return fyo.pesa(String(val)).store; } catch { return String(val); }
    };

    onMounted(loadMatches);

    return {
      loading, actioning, matches, filteredMatches, tabs, tabCount,
      activeTab, decisionNote, acceptMatch, rejectMatch, confirmReject,
      cancelDecision, parseReasonCodes, formatMoney, loadMatches, t,
    };
  },
});
</script>
