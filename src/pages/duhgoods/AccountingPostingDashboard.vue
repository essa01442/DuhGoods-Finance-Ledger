<template>
  <div class="h-screen overflow-hidden flex flex-col" style="width: var(--w-desk)">
    <PageHeader :title="t`الترحيل المحاسبي`">
      <Button :label="t`ترحيل كل المقبول`" type="primary" :loading="posting" @click="postAll" />
    </PageHeader>

    <div class="flex-1 overflow-auto dark:bg-gray-875" dir="rtl">
      <!-- Filter tabs -->
      <div class="flex gap-1 p-3 border-b dark:border-gray-700">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          @click="activeTab = tab.value"
          class="px-3 py-1 rounded text-sm font-medium"
          :class="activeTab === tab.value ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800 dark:text-gray-300'"
        >
          {{ tab.label }} ({{ tabCount(tab.value) }})
        </button>
      </div>

      <!-- Unposted accepted reconciliations -->
      <div v-if="activeTab === 'pending'" class="divide-y dark:divide-gray-700">
        <div
          v-for="match in unpostedAccepted"
          :key="match.name"
          class="p-4 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-800"
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
            @click="postOne(match.name)"
          />
        </div>
        <div v-if="unpostedAccepted.length === 0" class="p-8 text-center text-gray-400">
          {{ t`لا توجد مطابقات مقبولة في انتظار الترحيل` }}
        </div>
      </div>

      <!-- Posted -->
      <div v-if="activeTab === 'posted'" class="divide-y dark:divide-gray-700">
        <div
          v-for="posting in postingsByStatus('posted')"
          :key="posting.name"
          class="p-4 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div>
            <div class="text-sm font-medium dark:text-gray-200">
              <bdi dir="ltr">{{ posting.name }}</bdi>
            </div>
            <div class="text-xs text-gray-500">{{ posting.postingType }}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-green-600 text-sm">✓ {{ t`مرحّل` }}</span>
            <Button size="small" :label="t`عكس`" type="danger" @click="reversePosting(posting.name)" :loading="reversingPosting === posting.name" />
          </div>
        </div>
        <div v-if="postingsByStatus('posted').length === 0" class="p-8 text-center text-gray-400">
          {{ t`لا توجد قيود مرحّلة` }}
        </div>
      </div>

      <!-- Exceptions -->
      <div v-if="activeTab === 'exceptions'" class="divide-y dark:divide-gray-700">
        <div
          v-for="posting in postingsByStatus('exception')"
          :key="posting.name"
          class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <div class="flex justify-between">
            <div class="text-sm font-medium dark:text-gray-200"><bdi dir="ltr">{{ posting.name }}</bdi></div>
            <span class="text-red-600 text-sm">{{ t`استثناء` }}</span>
          </div>
          <div class="text-xs text-red-500 mt-1">{{ posting.exceptionMessage }}</div>
        </div>
        <div v-if="postingsByStatus('exception').length === 0" class="p-8 text-center text-gray-400">
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
import { DuhGoodsAccountingPostingService } from 'duhgoods/accounting/AccountingPostingService';

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

    const load = async () => {
      loading.value = true;
      try {
        const [matches, postingRows] = await Promise.all([
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

        postings.value = postingRows as PostingRow[];
        const postedMatchNames = new Set(
          postingRows
            .filter((p) => (p as PostingRow).status === 'posted' || (p as PostingRow).status === 'reversing' || (p as PostingRow).status === 'reversed')
            .map((p) => (p as PostingRow).reconciliationMatch)
        );
        unpostedAccepted.value = (matches as { name: string }[])
          .filter((m) => !postedMatchNames.has(m.name))
          .map((m) => ({ name: m.name }));
      } finally {
        loading.value = false;
      }
    };

    const getAccountMapping = () => ({
      pspClearing: 'PSP Clearing',
      bank: 'Cash',
      sales: 'Sales',
      refunds: 'Sales Returns',
      chargebacks: 'Bad Debts',
      feeExpense: 'Bank Charges',
      taxPayable: 'VAT Payable',
      shippingRevenue: 'Shipping Revenue',
      discounts: 'Discounts',
    });

    const postOne = async (matchName: string) => {
      postingMatch.value = matchName;
      try {
        const svc = new DuhGoodsAccountingPostingService(fyo, getAccountMapping());
        await svc.post(matchName);
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      } finally {
        postingMatch.value = '';
      }
    };

    const postAll = async () => {
      posting.value = true;
      try {
        const svc = new DuhGoodsAccountingPostingService(fyo, getAccountMapping());
        for (const match of unpostedAccepted.value) {
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
        const svc = new DuhGoodsAccountingPostingService(fyo, getAccountMapping());
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
      tabCount, postingsByStatus,
      postOne, postAll, reversePosting, load, t,
    };
  },
});
</script>
