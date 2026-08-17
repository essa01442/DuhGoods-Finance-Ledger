import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'tape';
import { BackupService } from '../duhgoods/backup/BackupService';
import { closeTestFyo, getTestFyo, getTestDbPath, setupTestFyo } from './helpers';
import setupInstance from 'src/setup/setupInstance';
import { DatabaseManager } from 'backend/database/manager';
import { getTestSetupWizardOptions } from './helpers';

// ── listBackups — no DB required ──────────────────────────────────────────────

test('BackupService: listBackups - returns empty array for missing dir', (t) => {
  const fyo = getTestFyo();
  const svc = new BackupService(fyo);
  const result = svc.listBackups('/nonexistent/dir/12345');
  t.deepEqual(result, [], 'empty array for nonexistent dir');
  t.end();
});

test('BackupService: listBackups - lists only duhgoods-backup-*.db files', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-backup-list-'));
  fs.writeFileSync(path.join(tmpDir, 'duhgoods-backup-2026-07-01T00-00-00.db'), 'fake');
  fs.writeFileSync(path.join(tmpDir, 'duhgoods-backup-2026-07-02T00-00-00.db'), 'fake2');
  fs.writeFileSync(path.join(tmpDir, 'other-file.db'), 'ignored');
  fs.writeFileSync(path.join(tmpDir, 'duhgoods-backup-notadb.txt'), 'ignored');

  const fyo = getTestFyo();
  const svc = new BackupService(fyo);
  const list = svc.listBackups(tmpDir);
  t.equal(list.length, 2, 'only 2 matching backup files');
  t.ok(
    list.every((f) => f.name.startsWith('duhgoods-backup-') && f.name.endsWith('.db')),
    'all entries match pattern'
  );
  fs.rmSync(tmpDir, { recursive: true });
  t.end();
});

// ── validateBackup — no DB required ──────────────────────────────────────────

test('BackupService: validateBackup - returns invalid for nonexistent file', (t) => {
  const fyo = getTestFyo();
  const svc = new BackupService(fyo);
  const result = svc.validateBackup('/no/such/file.db');
  t.ok(!result.valid, 'invalid');
  t.ok(result.message.includes('not found'), 'message mentions not found');
  t.end();
});

// ── createBackup + validate — requires real file-backed DB ───────────────────

const fyoFile = getTestFyo();

test('setup: BackupService file-backed DB', async () => {
  const tmpDb = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dg-backup-db-')),
    'test.db'
  );
  const options = getTestSetupWizardOptions();
  await setupInstance(tmpDb, options, fyoFile);
});

test('BackupService: createBackup + validateBackup round-trip', async (t) => {
  const dbPath = (fyoFile.db as unknown as { dbPath?: string }).dbPath;
  if (!dbPath || dbPath === ':memory:') {
    t.skip('no file-backed db available in this environment');
    t.end();
    return;
  }

  const svc = new BackupService(fyoFile);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-backup-'));

  try {
    const result = await svc.createBackup(backupDir);
    t.ok(fs.existsSync(result.backupPath), 'backup file was created');
    t.ok(result.sizeBytes > 0, 'backup has size > 0');
    t.ok(result.createdAt instanceof Date, 'createdAt is a Date');

    const validation = svc.validateBackup(result.backupPath);
    t.ok(validation.valid, `backup validates: ${validation.message}`);

    const listed = svc.listBackups(backupDir);
    t.equal(listed.length, 1, 'one backup listed');
    t.equal(listed[0].path, result.backupPath, 'listed path matches created path');
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  t.end();
});

test('BackupService: createBackup - rejects in-memory database', async (t) => {
  const fyoMem = getTestFyo();
  const svc = new BackupService(fyoMem);
  try {
    await svc.createBackup('/tmp/anywhere');
    t.fail('should have thrown');
  } catch (e) {
    t.ok(e instanceof Error && e.message.includes('in-memory'), 'rejects in-memory db');
  }
  t.end();
});

test('cleanup: BackupService file-backed DB', async () => {
  await fyoFile.close();
});
