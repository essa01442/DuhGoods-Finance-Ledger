<template>
  <div
    class="h-screen overflow-hidden flex flex-col"
    style="width: var(--w-desk)"
  >
    <PageHeader :title="t`مراجعة أسعار الصرف الأجنبي`">
      <Button :label="t`تحديث`" @click="load" :loading="loading" />
    </PageHeader>

    <div class="flex-1 overflow-auto p-4 dark:bg-gray-875" dir="rtl">
      <!-- Manual rate entry -->
      <div
        class="mb-6 p-4 rounded border dark:border-gray-700 dark:bg-gray-800"
      >
        <h3 class="font-semibold mb-3 dark:text-gray-200">
          {{ t`إضافة سعر صرف يدوي` }}
        </h3>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
          <div>
            <label class="text-xs text-gray-500 dark:text-gray-400">{{
              t`التاريخ`
            }}</label>
            <input
              type="date"
              v-model="manualDate"
              class="
                w-full
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
            />
          </div>
          <div>
            <label class="text-xs text-gray-500 dark:text-gray-400">{{
              t`العملة الأساس`
            }}</label>
            <input
              type="text"
              v-model="manualBase"
              placeholder="USD"
              class="
                w-full
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
            />
          </div>
          <div>
            <label class="text-xs text-gray-500 dark:text-gray-400">{{
              t`عملة التسعير`
            }}</label>
            <input
              type="text"
              v-model="manualQuote"
              placeholder="SAR"
              class="
                w-full
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
            />
          </div>
          <div>
            <label class="text-xs text-gray-500 dark:text-gray-400">{{
              t`سعر الصرف`
            }}</label>
            <input
              type="text"
              inputmode="decimal"
              v-model="manualRate"
              :placeholder="t`مثال: 3.74`"
              class="
                w-full
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
            />
          </div>
          <div class="col-span-2">
            <label class="text-xs text-gray-500 dark:text-gray-400">{{
              t`مصدر السعر`
            }}</label>
            <input
              type="text"
              v-model="manualSource"
              :placeholder="t`مصدر السعر (مثال: بيان بنكي تاريخ ...)`"
              class="
                w-full
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
            />
          </div>
        </div>
        <div class="mt-3 flex gap-2 justify-end">
          <Button
            :label="t`حفظ السعر`"
            type="primary"
            :loading="savingRate"
            @click="saveManualRate"
          />
        </div>
        <div
          v-if="rateMessage"
          class="mt-2 text-sm"
          :class="rateMessageError ? 'text-red-600' : 'text-green-600'"
        >
          {{ rateMessage }}
        </div>
      </div>

      <!-- Records needing FX -->
      <h3 class="font-semibold mb-3 dark:text-gray-200">
        {{ t`معاملات تفتقر إلى سعر صرف` }}
      </h3>
      <div
        class="
          divide-y
          dark:divide-gray-700
          border
          rounded
          dark:border-gray-700
        "
      >
        <div
          v-for="record in fxPendingRecords"
          :key="record.name"
          class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div class="flex justify-between items-center">
            <div>
              <div class="text-sm font-medium dark:text-gray-200">
                <bdi dir="ltr">{{ record.name }}</bdi>
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                {{ record.currency }} ·
                <bdi dir="ltr">{{ record.netAmount }}</bdi> ·
                {{ formatDate(record.transactionDate) }}
              </div>
              <div class="text-xs text-red-500 mt-1">
                {{ record.fxReviewNote }}
              </div>
            </div>
            <Button
              size="small"
              :label="t`إعادة محاولة التحويل`"
              @click="retryFX(record.name)"
              :loading="retrying === record.name"
            />
          </div>
        </div>
        <div
          v-if="fxPendingRecords.length === 0"
          class="p-8 text-center text-gray-400"
        >
          {{ t`لا توجد معاملات تفتقر إلى سعر صرف ✓` }}
        </div>
      </div>

      <!-- Available FX rates -->
      <h3 class="font-semibold mt-6 mb-3 dark:text-gray-200">
        {{ t`أسعار الصرف المتاحة` }}
      </h3>
      <div
        class="
          divide-y
          dark:divide-gray-700
          border
          rounded
          dark:border-gray-700
        "
      >
        <div
          v-for="rate in fxRates"
          :key="rate.name"
          class="p-3 flex justify-between text-sm dark:bg-gray-800"
        >
          <div class="dark:text-gray-200">
            <bdi dir="ltr"
              >{{ rate.baseCurrency }}/{{ rate.quoteCurrency }}</bdi
            >
            = <bdi dir="ltr">{{ rate.rate }}</bdi>
          </div>
          <div class="text-gray-500 dark:text-gray-400">
            <bdi dir="ltr">{{ formatDate(rate.effectiveDate) }}</bdi>
            · {{ rate.origin === 'manual_entry' ? t`يدوي` : t`مستورد` }}
          </div>
        </div>
        <div v-if="fxRates.length === 0" class="p-4 text-center text-gray-400">
          {{ t`لا توجد أسعار صرف مسجلة` }}
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
import { FXService } from 'duhgoods/fx/FXService';

export default defineComponent({
  name: 'FXReview',
  components: { PageHeader, Button },
  setup() {
    const loading = ref(false);
    const savingRate = ref(false);
    const retrying = ref('');
    const fxPendingRecords = ref<Record<string, unknown>[]>([]);
    const fxRates = ref<Record<string, unknown>[]>([]);

    const manualDate = ref(new Date().toISOString().slice(0, 10));
    const manualBase = ref('');
    const manualQuote = ref('SAR');
    const manualRate = ref('');
    const manualSource = ref('');
    const rateMessage = ref('');
    const rateMessageError = ref(false);

    const fxService = new FXService(fyo);

    const load = async () => {
      loading.value = true;
      try {
        const [pending, rates] = await Promise.all([
          fyo.db
            .getAll(ModelNameEnum.DuhGoodsImportRecord, {
              filters: { fxReviewNote: ['!=', null] },
              fields: [
                'name',
                'transactionType',
                'transactionDate',
                'currency',
                'netAmount',
                'fxReviewNote',
              ],
              orderBy: 'transactionDate',
              order: 'desc',
            })
            .catch(() => []),
          fyo.db
            .getAll(ModelNameEnum.DuhGoodsFXRate, {
              fields: [
                'name',
                'effectiveDate',
                'baseCurrency',
                'quoteCurrency',
                'rate',
                'origin',
              ],
              orderBy: 'effectiveDate',
              order: 'desc',
            })
            .catch(() => []),
        ]);
        fxPendingRecords.value = pending as Record<string, unknown>[];
        fxRates.value = rates as Record<string, unknown>[];
      } finally {
        loading.value = false;
      }
    };

    const saveManualRate = async () => {
      if (
        !manualBase.value ||
        !manualQuote.value ||
        !manualRate.value ||
        !manualDate.value
      ) {
        rateMessage.value = t`يرجى ملء جميع الحقول`;
        rateMessageError.value = true;
        return;
      }
      savingRate.value = true;
      try {
        const result = await fxService.storeManualRate({
          effectiveDate: new Date(manualDate.value + 'T00:00:00Z'),
          baseCurrency: manualBase.value.toUpperCase(),
          quoteCurrency: manualQuote.value.toUpperCase(),
          rate: manualRate.value,
          sourceDescription:
            manualSource.value || `إدخال يدوي ${manualDate.value}`,
        });
        rateMessage.value = result.created
          ? t`تم حفظ سعر الصرف بنجاح`
          : t`سعر الصرف موجود مسبقاً`;
        rateMessageError.value = false;
        await load();
      } catch (e) {
        rateMessage.value = e instanceof Error ? e.message : String(e);
        rateMessageError.value = true;
      } finally {
        savingRate.value = false;
      }
    };

    const retryFX = async (recordName: string) => {
      retrying.value = recordName;
      try {
        const policy = await fyo.doc
          .getDoc(ModelNameEnum.DuhGoodsVATPolicy)
          .catch(() => null);
        const functionalCurrency =
          ((policy as Record<string, unknown>)?.functionalCurrency as string) ||
          'SAR';
        await fxService.applyToRecord(recordName, functionalCurrency);
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        retrying.value = '';
      }
    };

    const formatDate = (d: unknown): string => {
      if (!d) return '';
      try {
        return new Date(d as string).toISOString().slice(0, 10);
      } catch {
        return String(d);
      }
    };

    onMounted(load);

    return {
      loading,
      savingRate,
      retrying,
      fxPendingRecords,
      fxRates,
      manualDate,
      manualBase,
      manualQuote,
      manualRate,
      manualSource,
      rateMessage,
      rateMessageError,
      load,
      saveManualRate,
      retryFX,
      formatDate,
      t,
    };
  },
});
</script>
