import path from 'path';
import { _electron } from 'playwright';
import { fileURLToPath } from 'url';
import test from 'tape';

delete process.env.ELECTRON_RUN_AS_NODE;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..');
const appSourcePath = path.join(root, 'dist_electron', 'build', 'main.js');

const FORBIDDEN_ENGLISH_LABELS = [
  'Settings',
  'Chart of Accounts',
  'New Entry',
  'Save',
  'Cancel',
  'Reports',
  'Accounting',
  'Sales Invoice',
  'Sales Invoices',
  'Purchase Invoice',
  'Purchase Invoices',
  'General Ledger',
  'Profit and Loss',
];

async function checkVisibleEnglishGate(window, screenName, t) {
  const visibleText = await window.locator('body').innerText();
  const forbiddenFound = FORBIDDEN_ENGLISH_LABELS.filter((label) => {
    const regex = new RegExp(`\\b${label}\\b`, 'i');
    return regex.test(visibleText);
  });

  t.equal(
    forbiddenFound.length,
    0,
    `[${screenName}] Visible English gate passed (Found unexpected: ${forbiddenFound.join(
      ', '
    )})`
  );
}

(async function run() {
  const electronApp = await _electron.launch({
    args: ['--no-sandbox', '--disable-gpu', appSourcePath],
  });

  // Mock native Electron dialogs so modal prompts do not block automated CI tests
  // Note: dialog.showMessageBox is mocked to return default button response (0) so native OS modal dialogs do not block headless Playwright automation.
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });

  const window = await electronApp.firstWindow();

  // Electron IPC + Arabic language-map loading can take >30 s on first boot
  // under Xvfb; 120 s covers even the slowest headless environments.
  window.setDefaultTimeout(120_000);

  test('1. Load app & verify RTL default', async (t) => {
    t.equal(await window.title(), 'Frappe Books', 'title matches');

    // The page `load` event fires when the HTML finishes loading — BEFORE the
    // async renderer.ts chain (setLanguageMap + ipc.getEnv) completes and
    // app.mount('body') runs. Waiting for #app[dir] directly is the reliable
    // way to know Vue has mounted and set the RTL direction attribute.
    await window.waitForSelector('#app[dir]', { timeout: 120_000 });
    t.ok(true, 'Vue mounted and #app[dir] is present');

    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'clean install initial paint is RTL');
  });

  test('2. Navigate to database selector', async (t) => {
    // After Vue mounts it shows either the database selector (first run) or
    // the Desk with a sidebar change-db button (existing DB). We already
    // confirmed Vue mounted in test 1, so elements should appear quickly now.
    const changeDb = window.getByTestId('change-db');
    const createNew = window.getByTestId('create-new-file');

    // Try create-new-file first (fresh install); fall back to clicking change-db
    const createNewVisible = await createNew
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!createNewVisible) {
      await changeDb.waitFor({ state: 'visible' });
      await changeDb.click();
      await createNew.waitFor({ state: 'visible' });
    }

    t.ok(await createNew.isVisible(), 'create new is visible');
  });

  test('3. Fill setup form for Saudi Arabia', async (t) => {
    await window.getByTestId('create-new-file').click();
    await window.getByTestId('submit-button').waitFor();

    t.equal(
      await window.getByTestId('submit-button').isDisabled(),
      true,
      'submit button is disabled before form fill'
    );

    const companyNameInput = window
      .getByPlaceholder('Company Name')
      .or(window.getByPlaceholder('اسم الشركة'));
    const ownerInput = window
      .getByPlaceholder('John Doe')
      .or(window.getByPlaceholder('فلان الفلاني'));
    const emailInput = window.getByPlaceholder('john@doe.com');
    const countryInput = window
      .getByPlaceholder('Select Country')
      .or(window.getByPlaceholder('تحديد الدولة'));
    const bankInput = window
      .getByPlaceholder('Prime Bank')
      .or(window.getByPlaceholder('البنك الرئيسي'));

    await companyNameInput.fill('شركة ده بضائع');
    await companyNameInput.blur();
    await ownerInput.fill('مدير النظام');
    await ownerInput.blur();
    await emailInput.fill('info@duhgoods.com');
    await emailInput.blur();
    await bankInput.fill('البنك الأهلي السعودي');
    await bankInput.blur();
    await countryInput.fill('Saudi Arabia');
    await countryInput.blur();

    t.equal(
      await window.getByTestId('submit-button').isDisabled(),
      false,
      'submit button enabled after form fill for Saudi Arabia'
    );
  });

  test('4. Create new instance & verify post-onboarding Arabic Desk', async (t) => {
    const startTime = Date.now();
    await window.getByTestId('submit-button').click();

    const companyNameEl = window.getByTestId('company-name');
    await companyNameEl.waitFor({ state: 'visible', timeout: 60_000 });
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[UI Test Metric] Instance initialization duration: ${duration}s under Xvfb`
    );

    t.equal(
      await companyNameEl.innerText(),
      'شركة ده بضائع',
      'new instance created, company name found in sidebar'
    );

    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'post-onboarding desk environment remains RTL');

    const deskHeading = await window.locator('body').innerText();
    t.ok(
      deskHeading.includes('شركة ده بضائع') ||
        deskHeading.includes('الرئيسية') ||
        deskHeading.includes('المحاسبة'),
      'Desk screen identity confirmed'
    );

    await checkVisibleEnglishGate(window, 'Desk', t);
  });

  test('5. UI Acceptance: Chart of Accounts Screen Navigation & Identity', async (t) => {
    await window.evaluate(() => {
      window.location.hash = '#/chart-of-accounts';
    });
    await window.waitForTimeout(1500);

    const url = window.url();
    t.ok(
      url.includes('chart-of-accounts'),
      `Chart of Accounts route open (${url})`
    );

    const pageText = await window.locator('body').innerText();
    t.ok(
      pageText.includes('دليل الحسابات') || pageText.includes('الأصول'),
      'Chart of Accounts screen identity confirmed'
    );

    await window.waitForSelector('#app[dir]');
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Chart of Accounts maintains dir="rtl"');

    await checkVisibleEnglishGate(window, 'Chart of Accounts', t);
  });

  test('6. UI Acceptance: Accounting Entry Screen Navigation & Identity', async (t) => {
    await window.evaluate(() => {
      window.location.hash = '#/list/SalesInvoice';
    });
    await window.waitForTimeout(1500);

    const url = window.url();
    t.ok(
      url.includes('SalesInvoice'),
      `Sales Invoice document route open (${url})`
    );

    const pageText = await window.locator('body').innerText();
    t.ok(
      pageText.includes('فواتير المبيعات') ||
        pageText.includes('فاتورة مبيعات'),
      'Accounting Entry screen identity confirmed'
    );

    await window.waitForSelector('#app[dir]');
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Accounting Entry screen maintains dir="rtl"');

    await checkVisibleEnglishGate(window, 'Accounting Entry', t);
  });

  test('7. UI Acceptance: Settings Screen Navigation & Identity', async (t) => {
    await window.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await window.waitForTimeout(1500);

    const url = window.url();
    t.ok(url.includes('settings'), `Settings route open (${url})`);

    const pageText = await window.locator('body').innerText();
    t.ok(
      pageText.includes('الإعدادات') || pageText.includes('إعدادات'),
      'Settings screen identity confirmed'
    );

    await window.waitForSelector('#app[dir]');
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Settings screen maintains dir="rtl"');

    await checkVisibleEnglishGate(window, 'Settings', t);
  });

  test('8. UI Acceptance: Report Screen Navigation & Identity', async (t) => {
    await window.evaluate(() => {
      window.location.hash = '#/report/ProfitAndLoss';
    });
    await window.waitForTimeout(1500);

    const url = window.url();
    t.ok(url.includes('report'), `Report route open (${url})`);

    const pageText = await window.locator('body').innerText();
    t.ok(
      pageText.includes('قائمة الدخل') ||
        pageText.includes('دفتر الأستاذ العام') ||
        pageText.includes('التقارير'),
      'Report screen identity confirmed'
    );

    await window.waitForSelector('#app[dir]');
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Report screen maintains dir="rtl"');

    await checkVisibleEnglishGate(window, 'Desk', t);
  });

  test('9. UI Acceptance: General Ledger Screen — Arabic title, RTL, no English leak', async (t) => {
    await window.evaluate(() => {
      window.location.hash = '#/report/GeneralLedger';
    });
    await window.waitForTimeout(2000);

    const url = window.url();
    t.ok(
      url.includes('GeneralLedger') || url.includes('general-ledger'),
      `General Ledger route open (${url})`
    );

    await window.waitForSelector('#app[dir]');
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'General Ledger screen maintains dir="rtl"');

    const pageText = await window.locator('body').innerText();
    t.ok(
      pageText.includes('دفتر الأستاذ العام'),
      'Arabic title "دفتر الأستاذ العام" is visible on General Ledger screen'
    );

    const englishRegex = /\bGeneral Ledger\b/;
    t.notOk(
      englishRegex.test(pageText),
      'English "General Ledger" must NOT be visible on General Ledger screen'
    );

    await checkVisibleEnglishGate(window, 'General Ledger', t);
  });

  test('10. Close app', async (t) => {
    await electronApp.close();
    t.ok(true, 'app closed without errors');
  });
})();
