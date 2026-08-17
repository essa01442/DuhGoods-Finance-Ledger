<template>
  <div class="h-screen overflow-hidden flex flex-col" style="width: var(--w-desk)">
    <PageHeader :title="t`مراجعة ضريبة القيمة المضافة`">
      <Button :label="t`تحديث`" @click="load" :loading="loading" />
    </PageHeader>

    <div class="flex-1 overflow-auto p-4 dark:bg-gray-875" dir="rtl">
      <div class="mb-4 p-3 rounded border dark:border-gray-700 dark:bg-gray-800">
        <div class="text-sm font-semibold dark:text-gray-200 mb-1">{{ t`القاعدة: لا يُفترض تلقائياً أن أي معاملة خاضعة للضريبة أو معفاة. يُطلب مراجعة بشرية للتصنيف الضريبي غير الواضح.` }}</div>
      </div>

      <div class="divide-y dark:divide-gray-700">
        <div
          v-for="record in pendingRecords"
          :key="record.name"
          class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div class="flex justify-between items-start gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-medium dark:text-gray-200">
                  <bdi dir="ltr">{{ record.name }}</bdi>
                </span>
                <TxTypeBadge :type="record.transactionType" />
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                {{ record.currency }} ·
                <bdi dir="ltr">{{ record.netAmount }}</bdi>
                · {{ formatDate(record.transactionDate) }}
              </div>
              <div v-if="record.vatReviewNote" class="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                {{ record.vatReviewNote }}
              </div>
            </div>
            <div class="shrink-0">
              <select
                :value="record.vatClassification"
                @change="(e) => setClassification(record.name, (e.target as HTMLSelectElement).value)"
                class="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
              >
                <option value="review_required">{{ t`مطلوب مراجعة` }}</option>
                <option value="taxable">{{ t`خاضع للضريبة` }}</option>
                <option value="zero_rated">{{ t`معدل صفري` }}</option>
                <option value="exempt">{{ t`معفى` }}</option>
                <option value="out_of_scope">{{ t`خارج النطاق` }}</option>
                <option value="input_vat">{{ t`ضريبة مدخلات` }}</option>
                <option value="output_vat">{{ t`ضريبة مخرجات` }}</option>
                <option value="recoverable_vat">{{ t`ضريبة قابلة للاسترداد` }}</option>
                <option value="non_recoverable_vat">{{ t`ضريبة غير قابلة للاسترداد` }}</option>
                <option value="not_applicable">{{ t`غير منطبق` }}</option>
              </select>
            </div>
          </div>
        </div>
        <div v-if="pendingRecords.length === 0" class="p-8 text-center text-gray-400">
          {{ t`لا توجد استثناءات ضريبية معلقة ✓` }}
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue';
import { t } from 'fyo';
import PageHeader from 'src/components/PageHeader.vue';
import Button from 'src/components/Button.vue';
import { fyo } from 'src/initFyo';
import { ModelNameEnum } from 'models/types';
import { VATEngine, type VATClassification } from 'duhgoods/vat/VATEngine';

const TxTypeBadge = defineComponent({
  name: 'TxTypeBadge',
  props: { type: String },
  setup(props) {
    const label = () => {
      const map: Record<string, string> = {
        order: 'طلب', payment: 'دفع', refund: 'استرداد', fee: 'رسوم',
        settlement: 'تسوية', chargeback: 'استرداد قسري',
        bank_credit: 'إيداع', bank_debit: 'سحب',
      };
      return map[props.type ?? ''] ?? props.type;
    };
    return { label };
  },
  template: `<span class="px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{{ label() }}</span>`,
});

export default defineComponent({
  name: 'VATReview',
  components: { PageHeader, Button, TxTypeBadge },
  setup() {
    const loading = ref(false);
    const pendingRecords = ref<Record<string, unknown>[]>([]);

    const load = async () => {
      loading.value = true;
      try {
        const rows = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
          filters: { vatClassification: ['in', ['review_required', null]] },
          fields: ['name', 'transactionType', 'transactionDate', 'currency', 'netAmount', 'vatClassification', 'vatReviewNote'],
          orderBy: 'transactionDate',
          order: 'desc',
        });
        pendingRecords.value = rows as Record<string, unknown>[];
      } finally {
        loading.value = false;
      }
    };

    const setClassification = async (recordName: string, classification: string) => {
      try {
        const engine = new VATEngine(fyo);
        await engine.setClassification(recordName, classification as VATClassification);
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    };

    const formatDate = (d: unknown): string => {
      if (!d) return '';
      try { return new Date(d as string).toISOString().slice(0, 10); } catch { return String(d); }
    };

    onMounted(load);

    return { loading, pendingRecords, load, setClassification, formatDate, t };
  },
});
</script>
