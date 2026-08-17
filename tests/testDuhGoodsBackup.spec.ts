import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'tape';
import { BackupService } from '../duhgoods/backup/BackupService';
import {
  closeTestFyo,
  getTestFyo,
  getTestDbPath,
  setupTestFyo,
} from './helpers';
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
  fs.writeFileSync(
    path.join(tmpDir, 'duhgoods-backup-2026-07-01T00-00-00.db'),
    'fake'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'duhgoods-backup-2026-07-02T00-00-00.db'),
    'fake2'
  );
  fs.writeFileSync(path.join(tmpDir, 'other-file.db'), 'ignored');
  fs.writeFileSync(path.join(tmpDir, 'duhgoods-backup-notadb.txt'), 'ignored');

  const fyo = getTestFyo();
  const svc = new BackupService(fyo);
  const list = svc.listBackups(tmpDir);
  t.equal(list.length, 2, 'only 2 matching backup files');
  t.ok(
    list.every(
      (f) => f.name.startsWith('duhgoods-backup-') && f.name.endsWith('.db')
    ),
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
    t.equal(
      listed[0].path,
      result.backupPath,
      'listed path matches created path'
    );
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
    t.ok(
      e instanceof Error && e.message.includes('in-memory'),
      'rejects in-memory db'
    );
  }
  t.end();
});

test('BackupService: validateBackup - rejects corrupt backup file', (t) => {
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dg-corrupt-')),
    'duhgoods-backup-corrupt.db'
  );
  // Write garbage — not a valid SQLite database.
  fs.writeFileSync(
    tmpFile,
    Buffer.from('this is not a sqlite database', 'utf8')
  );
  const fyo = getTestFyo();
  const svc = new BackupService(fyo);
  const result = svc.validateBackup(tmpFile);
  t.ok(!result.valid, 'corrupt backup is invalid');
  t.ok(result.message.length > 0, 'has an error message');
  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  t.end();
});

test('BackupService: restore - rejects corrupt backup before touching live DB', async (t) => {
  const dbPath = (fyoFile.db as unknown as { dbPath?: string }).dbPath;
  if (!dbPath || dbPath === ':memory:') {
    t.skip('no file-backed db available');
    t.end();
    return;
  }

  const corruptFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dg-restore-corrupt-')),
    'corrupt.db'
  );
  fs.writeFileSync(corruptFile, Buffer.from('garbage', 'utf8'));
  const safetyDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'dg-restore-safety-')
  );

  const svc = new BackupService(fyoFile);
  const result = await svc.restore(corruptFile, safetyDir);
  t.ok(!result.ok, 'restore correctly rejected corrupt backup');
  t.ok(result.message.length > 0, 'has Arabic error message');

  // Live DB must still be open and usable.
  const dbPathAfter = (fyoFile.db as unknown as { dbPath?: string }).dbPath;
  t.equal(dbPathAfter, dbPath, 'live DB path unchanged after rejected restore');

  fs.rmSync(path.dirname(corruptFile), { recursive: true, force: true });
  fs.rmSync(safetyDir, { recursive: true, force: true });
  t.end();
});

test('BackupService: restore - round-trip restore succeeds for valid backup', async (t) => {
  const dbPath = (fyoFile.db as unknown as { dbPath?: string }).dbPath;
  if (!dbPath || dbPath === ':memory:') {
    t.skip('no file-backed db available');
    t.end();
    return;
  }

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-restore-src-'));
  const safetyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-restore-dst-'));
  const svc = new BackupService(fyoFile);

  try {
    // Create a valid backup.
    const backup = await svc.createBackup(backupDir);
    t.ok(fs.existsSync(backup.backupPath), 'backup created');

    // Restore from it — DB is closed and re-opened inside restore().
    const result = await svc.restore(backup.backupPath, safetyDir);
    t.ok(result.ok, `restore succeeded: ${result.message}`);
    t.ok(
      result.message.includes('تمت الاستعادة'),
      'Arabic success message present'
    );

    // Safety backup must exist.
    const safety = svc.listBackups(safetyDir);
    t.equal(safety.length, 1, 'one safety backup created');
    t.ok(safety[0].sizeBytes > 0, 'safety backup has size');

    // Live DB file must still exist.
    t.ok(fs.existsSync(dbPath), 'live DB file still exists after restore');
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(safetyDir, { recursive: true, force: true });
  }
  t.end();
});

test('cleanup: BackupService file-backed DB', async () => {
  await fyoFile.close();
});
