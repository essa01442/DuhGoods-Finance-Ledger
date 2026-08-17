<template>
  <div
    class="h-screen overflow-hidden flex flex-col"
    style="width: var(--w-desk)"
  >
    <PageHeader :title="t`المعالجة اليومية`">
      <Button
        :label="t`تشغيل التسوية`"
        type="primary"
        @click="runReconciliation"
        :loading="reconciling"
      />
    </PageHeader>

    <div class="flex-1 overflow-auto p-4 dark:bg-gray-875" dir="rtl">
      <!-- Status Summary -->
      <div v-if="summary" class="mb-6">
        <div
          class="rounded-lg border p-4 mb-4"
          :class="
            summary.balanced
              ? 'border-green-400 bg-green-50 dark:bg-green-900'
              : 'border-yellow-400 bg-yellow-50 dark:bg-yellow-900'
          "
        >
          <div class="text-xl font-bold">
            {{ summary.balanced ? t`اليوم متوازن ✓` : t`يوجد بنود معلقة` }}
          </div>
          <div v-if="!summary.balanced" class="mt-2">
            <div
              v-for="item in summary.openItems"
              :key="item"
              class="text-sm text-yellow-800 dark:text-yellow-200"
            >
              • {{ item }}
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard :label="t`مستورد`" :value="summary.imported" />
          <StatCard :label="t`متخطى`" :value="summary.skipped" />
          <StatCard
            :label="t`استثناءات`"
            :value="summary.exceptions"
            :highlight="summary.exceptions > 0"
          />
          <StatCard
            :label="t`أخطاء`"
            :value="summary.errors"
            :highlight="summary.errors > 0"
          />
          <StatCard :label="t`مطابق تلقائياً`" :value="summary.matched" />
          <StatCard
            :label="t`غير مطابق`"
            :value="summary.unmatched"
            :highlight="summary.unmatched > 0"
          />
          <StatCard
            :label="t`غامض`"
            :value="summary.ambiguous"
            :highlight="summary.ambiguous > 0"
          />
          <StatCard :label="t`مقبول`" :value="summary.accepted" />
          <StatCard :label="t`مرحّل محاسبياً`" :value="summary.posted" />
          <StatCard
            :label="t`استثناءات ضريبية`"
            :value="summary.vatExceptions"
            :highlight="summary.vatExceptions > 0"
          />
          <StatCard
            :label="t`استثناءات صرف أجنبي`"
            :value="summary.fxExceptions"
            :highlight="summary.fxExceptions > 0"
          />
        </div>
      </div>

      <!-- File Import Section -->
      <div class="mb-6">
        <h2 class="text-lg font-semibold mb-3 dark:text-gray-200">
          {{ t`استيراد الملفات اليومية` }}
        </h2>

        <div class="space-y-3">
          <!-- WooCommerce -->
          <FileImportRow
            :label="t`ملف WooCommerce`"
            source-type="woocommerce"
            :namespace="wooNamespace"
            @namespace-change="(v) => (wooNamespace = v)"
            @file-selected="(f) => (wooFile = f)"
            :result="importResults.woocommerce"
          />

          <!-- PSP -->
          <FileImportRow
            :label="t`ملف مزود الدفع (PSP)`"
            source-type="psp_export"
            :namespace="pspNamespace"
            @namespace-change="(v) => (pspNamespace = v)"
            @file-selected="(f) => (pspFile = f)"
            :currency="pspCurrency"
            @currency-change="(v) => (pspCurrency = v)"
            :result="importResults.psp"
          />

          <!-- Bank -->
          <FileImportRow
            :label="t`كشف حساب بنكي`"
            source-type="bank_statement"
            :namespace="bankNamespace"
            @namespace-change="(v) => (bankNamespace = v)"
            @file-selected="(f) => (bankFile = f)"
            :currency="bankCurrency"
            @currency-change="(v) => (bankCurrency = v)"
            :result="importResults.bank"
          />

          <!-- FX rates -->
          <FileImportRow
            :label="t`ملف أسعار الصرف (اختياري)`"
            source-type="fx_rates"
            @file-selected="(f) => (fxFile = f)"
            :result="importResults.fx"
            :optional="true"
          />
        </div>

        <div class="mt-4 flex gap-3 justify-end">
          <Button
            :label="t`استيراد الملفات`"
            type="primary"
            :loading="importing"
            :disabled="!hasAnyFile"
            @click="runImport"
          />
        </div>
      </div>

      <!-- Error list -->
      <div
        v-if="importErrors.length > 0"
        class="mb-4 p-3 rounded border border-red-300 bg-red-50 dark:bg-red-900"
      >
        <div class="font-semibold text-red-700 dark:text-red-300 mb-1">
          {{ t`أخطاء الاستيراد` }}
        </div>
        <div
          v-for="(err, i) in importErrors"
          :key="i"
          class="text-sm text-red-600 dark:text-red-400"
        >
          {{ err }}
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed } from 'vue';
import { t } from 'fyo';
import PageHeader from 'src/components/PageHeader.vue';
import Button from 'src/components/Button.vue';
import { fyo } from 'src/initFyo';
import { DailyOrchestrator, type DailyControlSummary } from 'duhgoods/daily/DailyOrchestrator';
import { DuhGoodsReconciliationService } from "duhgoods/reconciliation/ReconciliationService";;

const StatCard = defineComponent({
  name: 'StatCard',
  props: {
    label: { type: String, required: true },
    value: { type: [String, Number], required: true },
    highlight: { type: Boolean, default: false },
  },
  template: `
    <div class="rounded border p-3 dark:bg-gray-800" :class="highlight ? 'border-yellow-400' : 'border-gray-200 dark:border-gray-700'">
      <div class="text-xs text-gray-500 dark:text-gray-400">{{ label }}</div>
      <div class="text-2xl font-bold mt-1" :class="highlight ? 'text-yellow-600' : 'dark:text-gray-200'">{{ value }}</div>
    </div>
  `,
});

const FileImportRow = defineComponent({
  name: 'FileImportRow',
  props: {
    label: { type: String, required: true },
    sourceType: { type: String, required: true },
    namespace: { type: String, default: '' },
    currency: { type: String, default: '' },
    result: { type: Object as () => { imported: number; skipped: number; exceptions: number } | null, default: null },
    optional: { type: Boolean, default: false },
  },
  emits: ['file-selected', 'namespace-change', 'currency-change'],
  setup(props, { emit }) {
    const selectedFileName = ref('');
    const handleFileChange = async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      selectedFileName.value = file.name;
      const buffer = await file.arrayBuffer();
      emit('file-selected', { buffer: Buffer.from(buffer), name: file.name });
    };
    return { selectedFileName, handleFileChange, t };
  },
  template: `
    <div class="flex items-start gap-3 p-3 rounded border dark:border-gray-700 dark:bg-gray-800">
      <div class="flex-1">
        <div class="font-medium text-sm mb-1 dark:text-gray-200">{{ label }}</div>
        <div class="flex gap-2 flex-wrap">
          <input
            v-if="sourceType !== 'fx_rates'"
            type="text"
            :value="namespace"
            @input="$emit('namespace-change', ($event.target as HTMLInputElement).value)"
            :placeholder="t\`معرف المصدر (namespace)\`"
            class="border rounded px-2 py-1 text-sm flex-1 min-w-0 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
          />
          <input
            v-if="currency !== undefined && sourceType !== 'fx_rates' && sourceType !== 'woocommerce'"
            type="text"
            :value="currency"
            @input="$emit('currency-change', ($event.target as HTMLInputElement).value)"
            :placeholder="t\`العملة (مثال: SAR)\`"
            class="border rounded px-2 py-1 text-sm w-24 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
          />
          <label class="cursor-pointer border rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 hover:bg-gray-50">
            {{ selectedFileName || t\`اختر ملف...\` }}
            <input type="file" accept=".json,.csv" class="hidden" @change="handleFileChange" />
          </label>
        </div>
      </div>
      <div v-if="result" class="text-xs text-right min-w-fit">
        <div class="text-green-600">{{ t\`مستورد\` }}: {{ result.imported }}</div>
        <div class="text-gray-500">{{ t\`متخطى\` }}: {{ result.skipped }}</div>
        <div v-if="result.exceptions" class="text-yellow-600">{{ t\`استثناءات\` }}: {{ result.exceptions }}</div>
      </div>
    </div>
  `,
});

export default defineComponent({
  name: 'DailyWorkflow',
  components: { PageHeader, Button, StatCard, FileImportRow },
  setup() {
    const importing = ref(false);
    const reconciling = ref(false);
    const summary = ref<DailyControlSummary | null>(null);
    const importErrors = ref<string[]>([]);

    const wooNamespace = ref('woo:store1');
    const pspNamespace = ref('psp:provider1');
    const bankNamespace = ref('bank:main');
    const pspCurrency = ref('');
    const bankCurrency = ref('');

    const wooFile = ref<{ buffer: Buffer; name: string } | null>(null);
    const pspFile = ref<{ buffer: Buffer; name: string } | null>(null);
    const bankFile = ref<{ buffer: Buffer; name: string } | null>(null);
    const fxFile = ref<{ buffer: Buffer; name: string } | null>(null);

    type DisplayResult = { imported: number; skipped: number; exceptions: number };
    const importResults = ref<{
      woocommerce?: DisplayResult | null;
      psp?: DisplayResult | null;
      bank?: DisplayResult | null;
      fx?: DisplayResult | null;
    }>({});

    const hasAnyFile = computed(
      () => !!(wooFile.value || pspFile.value || bankFile.value || fxFile.value)
    );

    const orchestrator = new DailyOrchestrator(fyo);

    const runImport = async () => {
      importing.value = true;
      importErrors.value = [];
      importResults.value = {};

      const spec: Parameters<typeof orchestrator.runDailyImport>[0] = {};

      if (wooFile.value) {
        spec.woocommerce = {
          content: wooFile.value.buffer,
          namespace: wooNamespace.value,
          fileName: wooFile.value.name,
        };
      }
      if (pspFile.value) {
        spec.psp = {
          content: pspFile.value.buffer,
          namespace: pspNamespace.value,
          fileName: pspFile.value.name,
          currency: pspCurrency.value || undefined,
        };
      }
      if (bankFile.value) {
        const currency = bankCurrency.value.trim().toUpperCase();
        if (!currency) {
          importErrors.value = [t`يرجى تحديد عملة كشف الحساب البنكي (مثال: SAR، USD)`];
          importing.value = false;
          return;
        }
        spec.bank = {
          content: bankFile.value.buffer,
          namespace: bankNamespace.value,
          fileName: bankFile.value.name,
          currency,
        };
      }
      if (fxFile.value) {
        spec.fx = {
          content: fxFile.value.buffer.toString('utf8'),
          fileName: fxFile.value.name,
        };
      }

      try {
        const result = await orchestrator.runDailyImport(spec);
        summary.value = result;

        // Map per-source results by sourceLabel tag (not mutable position).
        for (const r of result.importSources) {
          const d: DisplayResult = { imported: r.imported, skipped: r.skipped, exceptions: r.exceptions };
          if (r.sourceLabel === 'woocommerce') importResults.value.woocommerce = d;
          else if (r.sourceLabel === 'psp') importResults.value.psp = d;
          else if (r.sourceLabel === 'bank') importResults.value.bank = d;
        }
        if (result.fxResult) {
          importResults.value.fx = {
            imported: result.fxResult.imported,
            skipped: 0,
            exceptions: result.fxResult.errors.length,
          };
        }
      } catch (e) {
        importErrors.value = [e instanceof Error ? e.message : String(e)];
      } finally {
        importing.value = false;
      }
    };

    const runReconciliation = async () => {
      reconciling.value = true;
      try {
        const svc = new DuhGoodsReconciliationService(fyo);
        await svc.generateProposals();
        const current = summary.value;
        if (current) {
          summary.value = await orchestrator.buildSummary(current.importSources);
        }
      } catch (e) {
        importErrors.value = [e instanceof Error ? e.message : String(e)];
      } finally {
        reconciling.value = false;
      }
    };

    return {
      importing,
      reconciling,
      summary,
      importErrors,
      wooNamespace,
      pspNamespace,
      bankNamespace,
      pspCurrency,
      bankCurrency,
      wooFile,
      pspFile,
      bankFile,
      fxFile,
      importResults,
      hasAnyFile,
      runImport,
      runReconciliation,
      t,
    };
  },
});
</script>
