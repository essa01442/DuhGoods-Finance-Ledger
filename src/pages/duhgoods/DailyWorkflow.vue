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

      <!-- Profile Import Section -->
      <div class="mb-6">
        <h2 class="text-lg font-semibold mb-3 dark:text-gray-200">
          {{ t`استيراد بملف تعريفي` }}
        </h2>

        <div class="p-3 rounded border dark:border-gray-700 dark:bg-gray-800">
          <div class="flex gap-3 flex-wrap items-end mb-3">
            <!-- Profile selector -->
            <div class="flex-1 min-w-48">
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {{ t`الملف التعريفي` }}
              </div>
              <select
                v-model="selectedProfileName"
                class="
                  border
                  rounded
                  px-2
                  py-1
                  text-sm
                  w-full
                  dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
                "
                @change="onProfileChange"
              >
                <option value="">{{ t`-- اختر ملفاً تعريفياً --` }}</option>
                <option
                  v-for="p in profiles"
                  :key="String(p.name)"
                  :value="String(p.name)"
                >
                  {{ String(p.profileName || p.name) }}
                  ({{ String(p.sourceType || '') }},
                  {{ String(p.fileFormat || '') }})
                </option>
              </select>
            </div>

            <!-- Namespace override -->
            <div class="flex-1 min-w-40">
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {{ t`معرف المصدر (اختياري)` }}
              </div>
              <input
                type="text"
                v-model="profileNamespace"
                :placeholder="
                  selectedProfile
                    ? String(selectedProfile.defaultSourceNamespace || '')
                    : ''
                "
                class="
                  border
                  rounded
                  px-2
                  py-1
                  text-sm
                  w-full
                  dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
                "
              />
            </div>

            <!-- File picker -->
            <div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {{ t`الملف` }}
              </div>
              <label
                class="
                  cursor-pointer
                  border
                  rounded
                  px-2
                  py-1
                  text-sm
                  bg-white
                  dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
                  hover:bg-gray-50
                  block
                "
              >
                {{ profileFileName || t`اختر ملف...` }}
                <input
                  type="file"
                  accept=".json,.csv"
                  class="hidden"
                  @change="handleProfileFileChange"
                />
              </label>
            </div>

            <!-- Import button -->
            <Button
              :label="t`استيراد`"
              type="primary"
              :loading="importingProfile"
              :disabled="!selectedProfileName || !profileFile"
              @click="runProfileImport"
            />
          </div>

          <!-- Profile metadata -->
          <div
            v-if="selectedProfile"
            class="
              text-xs text-gray-500
              dark:text-gray-400
              flex
              gap-4
              flex-wrap
            "
          >
            <span
              >{{ t`المصدر` }}:
              {{ String(selectedProfile.sourceType || '-') }}</span
            >
            <span
              >{{ t`الصيغة` }}:
              {{ String(selectedProfile.fileFormat || '-') }}</span
            >
            <span v-if="selectedProfile.defaultCurrency">
              {{ t`العملة` }}: {{ String(selectedProfile.defaultCurrency) }}
            </span>
            <span v-if="selectedProfile.defaultSourceNamespace">
              {{ t`مصدر الاستيراد الافتراضي` }}:
              {{ String(selectedProfile.defaultSourceNamespace) }}
            </span>
          </div>

          <!-- Profile import result -->
          <div v-if="profileImportResult" class="mt-2 text-xs flex gap-4">
            <span class="text-green-600"
              >{{ t`مستورد` }}: {{ profileImportResult.imported }}</span
            >
            <span class="text-gray-500"
              >{{ t`متخطى` }}: {{ profileImportResult.skipped }}</span
            >
            <span
              v-if="profileImportResult.exceptions > 0"
              class="text-yellow-600"
              >{{ t`استثناءات` }}: {{ profileImportResult.exceptions }}</span
            >
          </div>

          <!-- Profile import errors -->
          <div
            v-if="profileImportErrors.length > 0"
            class="
              mt-2
              p-2
              rounded
              border border-red-300
              bg-red-50
              dark:bg-red-900
            "
          >
            <div
              v-for="(err, i) in profileImportErrors"
              :key="i"
              class="text-sm text-red-600 dark:text-red-400"
            >
              {{ err }}
            </div>
          </div>
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
import { defineComponent, ref, computed, onMounted } from 'vue';
import { t } from 'fyo';
import PageHeader from 'src/components/PageHeader.vue';
import Button from 'src/components/Button.vue';
import { fyo } from 'src/initFyo';
import { ModelNameEnum } from 'models/types';
import { DailyOrchestrator, type DailyControlSummary } from 'duhgoods/daily/DailyOrchestrator';
import { DuhGoodsReconciliationService } from 'duhgoods/reconciliation/ReconciliationService';

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

    type DisplayResult = { imported: number; skipped: number; exceptions: number };
    const importResults = ref<{
      woocommerce?: DisplayResult | null;
      psp?: DisplayResult | null;
      bank?: DisplayResult | null;
    }>({});

    const hasAnyFile = computed(
      () => !!(wooFile.value || pspFile.value || bankFile.value)
    );

    const orchestrator = new DailyOrchestrator(fyo);

    // ── Profile import state ────────────────────────────────────────────────
    type ProfileRow = {
      name: unknown;
      profileName: unknown;
      sourceType: unknown;
      fileFormat: unknown;
      defaultCurrency: unknown;
      defaultSourceNamespace: unknown;
    };

    const profiles = ref<ProfileRow[]>([]);
    const selectedProfileName = ref('');
    const selectedProfile = computed<ProfileRow | null>(
      () => profiles.value.find((p) => String(p.name) === selectedProfileName.value) ?? null
    );
    const profileFile = ref<{ buffer: Buffer; name: string } | null>(null);
    const profileFileName = ref('');
    const profileNamespace = ref('');
    const importingProfile = ref(false);
    const profileImportResult = ref<{ imported: number; skipped: number; exceptions: number } | null>(null);
    const profileImportErrors = ref<string[]>([]);

    const loadProfiles = async () => {
      try {
        profiles.value = (await fyo.db.getAll(ModelNameEnum.DuhGoodsImportProfile, {
          fields: ['name', 'profileName', 'sourceType', 'fileFormat', 'defaultCurrency', 'defaultSourceNamespace'],
        })) as ProfileRow[];
      } catch {
        profiles.value = [];
      }
    };

    const onProfileChange = () => {
      profileImportResult.value = null;
      profileImportErrors.value = [];
    };

    const handleProfileFileChange = async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      profileFileName.value = file.name;
      const buffer = await file.arrayBuffer();
      profileFile.value = { buffer: Buffer.from(buffer), name: file.name };
    };

    const runProfileImport = async () => {
      if (!selectedProfileName.value || !profileFile.value) return;
      importingProfile.value = true;
      profileImportErrors.value = [];
      profileImportResult.value = null;

      try {
        const ns = profileNamespace.value.trim() || undefined;
        const result = await orchestrator.runProfileImport(
          selectedProfileName.value,
          profileFile.value.buffer,
          { sourceNamespace: ns, sourceFile: profileFile.value.name }
        );
        profileImportResult.value = {
          imported: result.imported,
          skipped: result.skipped,
          exceptions: result.exceptions,
        };
        // Refresh summary to include profile records in the run scope.
        if (summary.value) {
          const updatedSources = [...summary.value.importSources, result];
          const updatedSourceIds = [...summary.value.runSourceIds, result.sourceId];
          summary.value = await orchestrator.buildSummary(updatedSources, [], updatedSourceIds);
        }
      } catch (e) {
        profileImportErrors.value = [e instanceof Error ? e.message : String(e)];
      } finally {
        importingProfile.value = false;
      }
    };

    onMounted(loadProfiles);

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
      importResults,
      hasAnyFile,
      runImport,
      runReconciliation,
      // Profile import
      profiles,
      selectedProfileName,
      selectedProfile,
      profileFile,
      profileFileName,
      profileNamespace,
      importingProfile,
      profileImportResult,
      profileImportErrors,
      onProfileChange,
      handleProfileFileChange,
      runProfileImport,
      t,
    };
  },
});
</script>
