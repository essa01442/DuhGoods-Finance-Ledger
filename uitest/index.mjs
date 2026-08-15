import path from 'path';
import { _electron } from 'playwright';
import { fileURLToPath } from 'url';
import test from 'tape';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..');
const appSourcePath = path.join(root, 'dist_electron', 'build', 'main.js');

(async function run() {
  const electronApp = await _electron.launch({
    args: ['--no-sandbox', '--disable-gpu', appSourcePath],
  });
  const window = await electronApp.firstWindow();
  window.setDefaultTimeout(60_000);

  test('load app & verify RTL default', async (t) => {
    t.equal(await window.title(), 'Frappe Books', 'title matches');

    await new Promise((r) => window.once('load', () => r()));
    t.ok(true, 'window has loaded');

    const appDir = await window.getAttribute('#app', 'dir');
    t.equal(appDir, 'rtl', 'clean install initial paint is RTL');
  });

  test('navigate to database selector', async (t) => {
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

  test('fill setup form for Saudi Arabia', async (t) => {
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
    await ownerInput.fill('مدير النظام');
    await emailInput.fill('info@duhgoods.com');
    await countryInput.fill('Saudi Arabia');
    await countryInput.blur();
    await bankInput.fill('البنك الأهلي السعودي');
    await bankInput.blur();

    t.equal(
      await window.getByTestId('submit-button').isDisabled(),
      false,
      'submit button enabled after form fill for Saudi Arabia'
    );
  });

  test('create new instance', async (t) => {
    await window.getByTestId('submit-button').click();
    t.equal(
      await window.getByTestId('company-name').innerText(),
      'شركة ده بضائع',
      'new instance created, company name found in sidebar'
    );
  });

  test('close app', async (t) => {
    await electronApp.close();
    t.ok(true, 'app closed without errors');
  });
})();
