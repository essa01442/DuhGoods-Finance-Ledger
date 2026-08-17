<template>
  <div
    class="h-screen overflow-hidden flex flex-col"
    style="width: var(--w-desk)"
  >
    <PageHeader :title="t`الترحيل المحاسبي`">
      <Button
        :label="t`ترحيل كل المقبول`"
        type="primary"
        :loading="posting"
        :disabled="!mappingConfigured"
        @click="postAll"
      />
    </PageHeader>

    <div class="flex-1 overflow-auto dark:bg-gray-875" dir="rtl">
      <!-- Account mapping configuration -->
      <div
        v-if="!mappingConfigured || showMappingConfig"
        class="m-4 p-4 rounded border"
        :class="
          mappingConfigured
            ? 'border-gray-300 dark:border-gray-600'
            : 'border-red-400 bg-red-50 dark:bg-red-900'
        "
      >
        <div class="flex justify-between items-center mb-3">
          <h3 class="font-semibold dark:text-gray-200">
            {{ t`إعداد خريطة الحسابات` }}
          </h3>
          <button
            v-if="mappingConfigured"
            @click="showMappingConfig = false"
            class="text-xs text-gray-500 hover:underline"
          >
            {{ t`إخفاء` }}
          </button>
        </div>
        <div
          v-if="!mappingConfigured"
          class="text-sm text-red-700 dark:text-red-300 mb-3"
        >
          {{
            t`يجب تحديد خريطة الحسابات قبل الترحيل. المفاتيح المطلوبة: حساب التسوية، البنك، المبيعات، المردودات، المطالبات.`
          }}
        </div>
        <div class="grid grid-cols-1 gap-2">
          <div
            v-for="field in mappingFields"
            :key="field.key"
            class="flex items-center gap-2"
          >
            <label
              class="text-xs text-gray-500 dark:text-gray-400 w-40 shrink-0"
              >{{ field.label }}</label
            >
            <select
              v-model="draftMapping[field.key]"
              class="
                flex-1
                border
                rounded
                px-2
                py-1
                text-sm
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              "
              :class="
                field.required && !draftMapping[field.key]
                  ? 'border-red-400'
                  : ''
              "
            >
              <option value="">
                {{ field.required ? t`(مطلوب)` : t`(اختياري)` }}
              </option>
              <option v-for="acc in allAccounts" :key="acc" :value="acc">
                {{ acc }}
              </option>
            </select>
          </div>
        </div>
        <div class="mt-3 flex gap-2">
          <Button
            type="primary"
            :label="t`حفظ خريطة الحسابات`"
            @click="saveMapping"
          />
          <Button
            v-if="mappingConfigured"
            :label="t`إلغاء`"
            @click="showMappingConfig = false"
          />
        </div>
        <div v-if="mappingError" class="mt-2 text-sm text-red-600">
          {{ mappingError }}
        </div>
      </div>

      <!-- Configure link when already set -->
      <div
        v-if="mappingConfigured && !showMappingConfig"
        class="mx-4 mt-2 text-xs text-gray-400"
      >
        <button @click="showMappingConfig = true" class="hover:underline">
          {{ t`تعديل خريطة الحسابات` }}
        </button>
      </div>

      <!-- Filter tabs -->
      <div class="flex gap-1 p-3 border-b dark:border-gray-700 mt-2">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          @click="activeTab = tab.value"
          class="px-3 py-1 rounded text-sm font-medium"
          :class="
            activeTab === tab.value
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 dark:bg-gray-800 dark:text-gray-300'
          "
        >
          {{ tab.label }} ({{ tabCount(tab.value) }})
        </button>
      </div>

      <!-- Unposted accepted reconciliations -->
      <div v-if="activeTab === 'pending'" class="divide-y dark:divide-gray-700">
        <div
          v-for="match in unpostedAccepted"
          :key="match.name"
          class="
            p-4
            flex
            justify-between
            items-center
            hover:bg-gray-50
            dark:hover:bg-gray-800
          "
        >
          <div>
            <div class="text-sm font-medium dark:text-gray-200">
              <bdi dir="ltr">{{ match.name }}</bdi>
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              {{ match.postingType || t`مطابقة مقبولة` }}
            </div>
          </div>
          <Button
            :label="t`ترحيل`"
            type="primary"
            size="small"
            :loading="postingMatch === match.name"
            :disabled="!mappingConfigured"
            @click="postOne(match.name)"
          />
        </div>
        <div
          v-if="unpostedAccepted.length === 0"
          class="p-8 text-center text-gray-400"
        >
          {{ t`لا توجد مطابقات مقبولة في انتظار الترحيل` }}
        </div>
      </div>

      <!-- Posted -->
      <div v-if="activeTab === 'posted'" class="divide-y dark:divide-gray-700">
        <div
          v-for="posting in postingsByStatus('posted')"
          :key="posting.name"
          class="
            p-4
            flex
            justify-between
            items-center
            hover:bg-gray-50
            dark:hover:bg-gray-800
          "
        >
          <div>
            <div class="text-sm font-medium dark:text-gray-200">
              <bdi dir="ltr">{{ posting.name }}</bdi>
            </div>
            <div class="text-xs text-gray-500">{{ posting.postingType }}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-green-600 text-sm">✓ {{ t`مرحّل` }}</span>
            <Button
              size="small"
              :label="t`عكس`"
              type="danger"
              @click="reversePosting(posting.name)"
              :loading="reversingPosting === posting.name"
            />
          </div>
        </div>
        <div
          v-if="postingsByStatus('posted').length === 0"
          class="p-8 text-center text-gray-400"
        >
          {{ t`لا توجد قيود مرحّلة` }}
        </div>
      </div>

      <!-- Exceptions -->
      <div
        v-if="activeTab === 'exceptions'"
        class="divide-y dark:divide-gray-700"
      >
        <div
          v-for="posting in postingsByStatus('exception')"
          :key="posting.name"
          class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div class="flex justify-between">
            <div class="text-sm font-medium dark:text-gray-200">
              <bdi dir="ltr">{{ posting.name }}</bdi>
            </div>
            <span class="text-red-600 text-sm">{{ t`استثناء` }}</span>
          </div>
          <div class="text-xs text-red-500 mt-1">
            {{ posting.exceptionMessage }}
          </div>
        </div>
        <div
          v-if="postingsByStatus('exception').length === 0"
          class="p-8 text-center text-gray-400"
        >
          {{ t`لا توجد استثناءات ترحيل` }}
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
import { DuhGoodsAccountingPostingService, type DuhGoodsAccountMapping } from 'duhgoods/accounting/AccountingPostingService';

const MAPPING_STORAGE_KEY = 'duhgoods-account-mapping-v1';

interface PostingRow {
  name: string;
  status: string;
  postingType: string;
  reconciliationMatch: string;
  exceptionMessage?: string;
}

interface MatchRow {
  name: string;
  postingType?: string;
}

interface MappingField {
  key: keyof DuhGoodsAccountMapping;
  label: string;
  required: boolean;
}

const MAPPING_FIELDS: MappingField[] = [
  { key: 'pspClearing', label: t`حساب تسوية مزود الدفع`, required: true },
  { key: 'bank', label: t`حساب البنك`, required: true },
  { key: 'sales', label: t`حساب المبيعات`, required: true },
  { key: 'refunds', label: t`حساب مردودات المبيعات`, required: true },
  { key: 'chargebacks', label: t`حساب المطالبات المرفوضة`, required: true },
  { key: 'feeExpense', label: t`حساب رسوم مزود الدفع`, required: false },
  { key: 'taxPayable', label: t`حساب ضريبة القيمة المضافة`, required: false },
  { key: 'shippingRevenue', label: t`حساب إيرادات الشحن`, required: false },
  { key: 'discounts', label: t`حساب الخصومات`, required: false },
];

function loadStoredMapping(): Partial<DuhGoodsAccountMapping> {
  try {
    const raw = localStorage.getItem(MAPPING_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<DuhGoodsAccountMapping>;
  } catch { /* ignore */ }
  return {};
}

function saveStoredMapping(m: Partial<DuhGoodsAccountMapping>): void {
  try {
    localStorage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

export default defineComponent({
  name: 'AccountingPostingDashboard',
  components: { PageHeader, Button },
  setup() {
    const loading = ref(false);
    const posting = ref(false);
    const postingMatch = ref('');
    const reversingPosting = ref('');
    const postings = ref<PostingRow[]>([]);
    const unpostedAccepted = ref<MatchRow[]>([]);
    const activeTab = ref<'pending' | 'posted' | 'exceptions'>('pending');
    const allAccounts = ref<string[]>([]);
    const draftMapping = ref<Partial<DuhGoodsAccountMapping>>(loadStoredMapping());
    const showMappingConfig = ref(false);
    const mappingError = ref('');

    const mappingFields = MAPPING_FIELDS;

    const tabs = [
      { label: t`في انتظار الترحيل`, value: 'pending' },
      { label: t`مرحّل`, value: 'posted' },
      { label: t`استثناءات`, value: 'exceptions' },
    ];

    const tabCount = (status: string) => {
      if (status === 'pending') return unpostedAccepted.value.length;
      return postings.value.filter((p) => p.status === status).length;
    };

    const postingsByStatus = (status: string) =>
      postings.value.filter((p) => p.status === status);

    const mappingConfigured = computed(() => {
      const m = draftMapping.value;
      return MAPPING_FIELDS.filter((f) => f.required).every((f) => !!m[f.key]);
    });

    const buildMapping = (): DuhGoodsAccountMapping => {
      const m = draftMapping.value;
      return {
        pspClearing: m.pspClearing!,
        bank: m.bank!,
        sales: m.sales!,
        refunds: m.refunds!,
        chargebacks: m.chargebacks!,
        feeExpense: m.feeExpense,
        taxPayable: m.taxPayable,
        shippingRevenue: m.shippingRevenue,
        discounts: m.discounts,
      };
    };

    const saveMapping = () => {
      mappingError.value = '';
      const missing = MAPPING_FIELDS.filter((f) => f.required && !draftMapping.value[f.key]);
      if (missing.length > 0) {
        mappingError.value = t`يرجى تحديد الحسابات المطلوبة: ` + missing.map((f) => f.label).join('، ');
        return;
      }
      saveStoredMapping(draftMapping.value);
      showMappingConfig.value = false;
    };

    const load = async () => {
      loading.value = true;
      try {
        const [accounts, matches, postingRows] = await Promise.all([
          fyo.db.getAll(ModelNameEnum.Account, {
            filters: { isGroup: false },
            fields: ['name'],
            orderBy: 'name',
            order: 'asc',
          }).catch(() => []),
          fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
            filters: { status: 'accepted' },
            fields: ['name'],
          }),
          fyo.db.getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
            fields: ['name', 'status', 'postingType', 'reconciliationMatch', 'exceptionMessage'],
            orderBy: 'name',
            order: 'desc',
          }),
        ]);

        allAccounts.value = (accounts as { name: string }[]).map((a) => a.name);
        postings.value = postingRows as PostingRow[];
        const postedMatchNames = new Set(
          postingRows
            .filter((p) => (p as PostingRow).status === 'posted' || (p as PostingRow).status === 'reversing' || (p as PostingRow).status === 'reversed')
            .map((p) => (p as PostingRow).reconciliationMatch)
        );
        unpostedAccepted.value = (matches as { name: string }[])
          .filter((m) => !postedMatchNames.has(m.name))
          .map((m) => ({ name: m.name }));

        // Show config if not set up yet.
        if (!mappingConfigured.value) showMappingConfig.value = true;
      } finally {
        loading.value = false;
      }
    };

    const postOne = async (matchName: string) => {
      if (!mappingConfigured.value) return;
      postingMatch.value = matchName;
      try {
        const svc = new DuhGoodsAccountingPostingService(fyo, buildMapping());
        await svc.post(matchName);
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        postingMatch.value = '';
      }
    };

    const postAll = async () => {
      if (!mappingConfigured.value) return;
      posting.value = true;
      try {
        const svc = new DuhGoodsAccountingPostingService(fyo, buildMapping());
        for (const match of unpostedAccepted.value) {
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          await svc.post(match.name).catch(() => {});
        }
        await load();
      } finally {
        posting.value = false;
      }
    };

    const reversePosting = async (postingName: string) => {
      reversingPosting.value = postingName;
      try {
        const svc = new DuhGoodsAccountingPostingService(fyo, buildMapping());
        await svc.reverse(postingName);
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        reversingPosting.value = '';
      }
    };

    onMounted(load);

    return {
      loading, posting, postingMatch, reversingPosting,
      postings, unpostedAccepted, activeTab, tabs,
      allAccounts, draftMapping, showMappingConfig, mappingConfigured, mappingError,
      mappingFields,
      tabCount, postingsByStatus,
      postOne, postAll, reversePosting, saveMapping, load, t,
    };
  },
});
</script>
