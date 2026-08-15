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
  window.setDefaultTimeout(30_000);

  test('1. Load app & verify RTL default', async (t) => {
    t.equal(await window.title(), 'Frappe Books', 'title matches');

    await new Promise((r) => window.once('load', () => r()));
    t.ok(true, 'window has loaded');

    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'clean install initial paint is RTL');
  });

  test('2. Navigate to database selector', async (t) => {
    const changeDb = window.getByTestId('change-db');
    const createNew = window.getByTestId('create-new-file');

    const changeDbPromise = changeDb
      .waitFor({ state: 'visible' })
      .then(() => 'change-db');
    const createNewPromise = createNew
      .waitFor({ state: 'visible' })
      .then(() => 'create-new-file');

    const el = await Promise.race([changeDbPromise, createNewPromise]);
    if (el === 'change-db') {
      await changeDb.click();
      await createNewPromise;
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

    await checkVisibleEnglishGate(window, 'Desk', t);
  });

  test('5. UI Acceptance: Chart of Accounts Screen', async (t) => {
    const coaLink = window
      .locator('a[href*="/chart-of-accounts"]')
      .or(window.locator('text=دليل الحسابات'))
      .first();
    if (await coaLink.isVisible()) {
      await coaLink.click();
      await window.waitForTimeout(1000);
    }
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Chart of Accounts maintains dir="rtl"');
    await checkVisibleEnglishGate(window, 'Chart of Accounts', t);
  });

  test('6. UI Acceptance: Accounting Entry / Document Screen', async (t) => {
    const salesInvoiceLink = window
      .locator('a[href*="/invoice/sales"]')
      .or(
        window
          .locator('text=فاتورة مبيعات')
          .or(window.locator('text=فواتير المبيعات'))
      )
      .first();
    if (await salesInvoiceLink.isVisible()) {
      await salesInvoiceLink.click();
      await window.waitForTimeout(1000);
    }
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Accounting Entry screen maintains dir="rtl"');
    await checkVisibleEnglishGate(window, 'Accounting Entry', t);
  });

  test('7. UI Acceptance: Settings Screen', async (t) => {
    const settingsLink = window
      .locator('a[href*="/settings"]')
      .or(window.locator('text=الإعدادات'))
      .first();
    if (await settingsLink.isVisible()) {
      await settingsLink.click();
      await window.waitForTimeout(1000);
    }
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Settings screen maintains dir="rtl"');
    await checkVisibleEnglishGate(window, 'Settings', t);
  });

  test('8. UI Acceptance: Report Screen', async (t) => {
    const reportLink = window
      .locator('a[href*="/report/"]')
      .or(
        window.locator('text=التقارير').or(window.locator('text=قائمة الدخل'))
      )
      .first();
    if (await reportLink.isVisible()) {
      await reportLink.click();
      await window.waitForTimeout(1000);
    }
    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'Report screen maintains dir="rtl"');
    await checkVisibleEnglishGate(window, 'Report', t);
  });

  test('9. Close app', async (t) => {
    await electronApp.close();
    t.ok(true, 'app closed without errors');
  });
})();
