<template>
  <div
    class="h-screen overflow-hidden flex flex-col"
    style="width: var(--w-desk)"
  >
    <PageHeader :title="t`النسخ الاحتياطي والاستعادة`" />

    <div class="flex-1 overflow-auto p-4 dark:bg-gray-875" dir="rtl">
      <div
        class="
          mb-4
          p-3
          rounded
          border border-blue-300
          bg-blue-50
          dark:bg-blue-900 dark:border-blue-700
        "
      >
        <div class="text-sm dark:text-blue-200">
          {{
            t`النسخ الاحتياطية محلية فقط. لا يتم رفع أي بيانات مالية إلى الإنترنت. يُوصى بالنسخ الاحتياطي اليومي إلى قرص خارجي أو مجلد آمن.`
          }}
        </div>
      </div>

      <!-- Backup -->
      <div
        class="mb-6 p-4 rounded border dark:border-gray-700 dark:bg-gray-800"
      >
        <h3 class="font-semibold mb-3 dark:text-gray-200">
          {{ t`إنشاء نسخة احتياطية` }}
        </h3>
        <div class="mb-3">
          <label class="text-xs text-gray-500 dark:text-gray-400">{{
            t`مجلد الحفظ`
          }}</label>
          <input
            type="text"
            v-model="backupDir"
            class="
              w-full
              border
              rounded
              px-2
              py-1
              text-sm
              dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              mt-1
            "
            :placeholder="t`مسار مجلد النسخ الاحتياطي`"
          />
        </div>
        <Button
          :label="t`إنشاء نسخة احتياطية الآن`"
          type="primary"
          :loading="backingUp"
          @click="createBackup"
        />
        <div v-if="backupResult" class="mt-2 text-sm text-green-600">
          ✓ {{ backupResult.backupPath }} ({{
            formatSize(backupResult.sizeBytes)
          }})
        </div>
        <div v-if="backupError" class="mt-2 text-sm text-red-600">
          {{ backupError }}
        </div>
      </div>

      <!-- Recent backups -->
      <div class="p-4 rounded border dark:border-gray-700 dark:bg-gray-800">
        <h3 class="font-semibold mb-3 dark:text-gray-200">
          {{ t`النسخ الاحتياطية المتاحة` }}
        </h3>
        <div class="divide-y dark:divide-gray-700">
          <div
            v-for="backup in backupList"
            :key="backup.path"
            class="py-2 flex justify-between items-center"
          >
            <div>
              <div class="text-sm font-medium dark:text-gray-200">
                <bdi dir="ltr">{{ backup.name }}</bdi>
              </div>
              <div class="text-xs text-gray-500">
                <bdi dir="ltr">{{ formatSize(backup.sizeBytes) }}</bdi> ·
                {{ formatDate(backup.mtime) }}
              </div>
            </div>
            <div class="flex gap-2">
              <Button
                size="small"
                :label="t`التحقق`"
                @click="validateBackup(backup.path)"
              />
              <Button
                size="small"
                type="danger"
                :label="t`استعادة`"
                :loading="restoringPath === backup.path"
                @click="initiateRestore(backup.path)"
              />
            </div>
          </div>
          <div
            v-if="backupList.length === 0"
            class="py-4 text-center text-gray-400 text-sm"
          >
            {{ t`لا توجد نسخ احتياطية في هذا المجلد` }}
          </div>
        </div>
        <div
          v-if="validateResult"
          class="mt-2 text-sm"
          :class="validateResult.valid ? 'text-green-600' : 'text-red-600'"
        >
          {{ validateResult.message }}
        </div>
      </div>

      <!-- Restore confirmation dialog -->
      <div
        v-if="restoreConfirmPath"
        class="
          mt-4
          p-4
          rounded
          border border-red-400
          bg-red-50
          dark:bg-red-900 dark:border-red-700
        "
      >
        <div class="font-semibold text-red-700 dark:text-red-300 mb-2">
          {{ t`تحذير: استعادة قاعدة البيانات` }}
        </div>
        <div class="text-sm text-red-700 dark:text-red-200 mb-3">
          {{
            t`سيتم إنشاء نسخة احتياطية أمان من البيانات الحالية قبل الاستعادة. هذه العملية لا يمكن التراجع عنها بعد تأكيدها.`
          }}
        </div>
        <div class="mb-3">
          <label class="text-xs text-gray-500 dark:text-gray-400">{{
            t`مجلد النسخة الاحتياطية الأمان`
          }}</label>
          <input
            type="text"
            v-model="safetyBackupDir"
            class="
              w-full
              border
              rounded
              px-2
              py-1
              text-sm
              dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200
              mt-1
            "
            :placeholder="t`مسار مجلد النسخة الأمان`"
          />
        </div>
        <div class="flex gap-2">
          <Button
            type="danger"
            :label="t`تأكيد الاستعادة`"
            :loading="restoring"
            @click="confirmRestore"
          />
          <Button
            :label="t`إلغاء`"
            @click="
              restoreConfirmPath = '';
              safetyBackupDir = '';
            "
          />
        </div>
        <div
          v-if="restoreResult"
          class="mt-2 text-sm"
          :class="restoreResult.ok ? 'text-green-600' : 'text-red-600'"
        >
          {{ restoreResult.message }}
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
import { BackupService } from 'duhgoods/backup/BackupService';
import type { BackupResult } from 'duhgoods/backup/BackupService';

export default defineComponent({
  name: 'BackupRestore',
  components: { PageHeader, Button },
  setup() {
    const backingUp = ref(false);
    const backupDir = ref('');
    const backupResult = ref<BackupResult | null>(null);
    const backupError = ref('');
    const backupList = ref<ReturnType<BackupService['listBackups']>>([]);
    const validateResult = ref<{ valid: boolean; message: string } | null>(
      null
    );
    const restoreConfirmPath = ref('');
    const safetyBackupDir = ref('');
    const restoring = ref(false);
    const restoringPath = ref('');
    const restoreResult = ref<{ ok: boolean; message: string } | null>(null);

    const svc = new BackupService(fyo);

    const createBackup = async () => {
      if (!backupDir.value) {
        backupError.value = t`يرجى تحديد مجلد الحفظ`;
        return;
      }
      backingUp.value = true;
      backupError.value = '';
      backupResult.value = null;
      try {
        backupResult.value = await svc.createBackup(backupDir.value);
        refreshList();
      } catch (e) {
        backupError.value = e instanceof Error ? e.message : String(e);
      } finally {
        backingUp.value = false;
      }
    };

    const validateBackup = (path: string) => {
      validateResult.value = svc.validateBackup(path);
    };

    const refreshList = () => {
      if (backupDir.value) {
        try {
          backupList.value = svc.listBackups(backupDir.value);
        } catch {
          backupList.value = [];
        }
      }
    };

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    };

    const formatDate = (d: Date) =>
      d.toISOString().slice(0, 19).replace('T', ' ');

    const initiateRestore = (path: string) => {
      validateResult.value = null;
      restoreResult.value = null;
      restoringPath.value = path;
      restoreConfirmPath.value = path;
      safetyBackupDir.value = backupDir.value || '';
    };

    const confirmRestore = async () => {
      if (!restoreConfirmPath.value) return;
      if (!safetyBackupDir.value.trim()) {
        restoreResult.value = {
          ok: false,
          message: t`يرجى تحديد مجلد النسخة الاحتياطية الأمان`,
        };
        return;
      }
      restoring.value = true;
      restoreResult.value = null;
      try {
        const result = await svc.restore(
          restoreConfirmPath.value,
          safetyBackupDir.value.trim()
        );
        restoreResult.value = result;
        if (result.ok) {
          restoreConfirmPath.value = '';
          restoringPath.value = '';
        }
      } catch (e) {
        restoreResult.value = {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      } finally {
        restoring.value = false;
      }
    };

    onMounted(() => {
      const dbPath = (fyo.db as unknown as { dbPath?: string }).dbPath;
      if (dbPath && dbPath !== ':memory:') {
        const parts = dbPath.split('/');
        parts.pop();
        backupDir.value = parts.join('/') + '/backups';
        refreshList();
      }
    });

    return {
      backingUp,
      backupDir,
      backupResult,
      backupError,
      backupList,
      validateResult,
      restoreConfirmPath,
      safetyBackupDir,
      restoring,
      restoringPath,
      restoreResult,
      createBackup,
      validateBackup,
      initiateRestore,
      confirmRestore,
      formatSize,
      formatDate,
      t,
    };
  },
});
</script>
