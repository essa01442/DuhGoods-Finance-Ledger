# DuhGoods Finance Ledger — Arabic Localization Standard

Status: **Mandatory**
Scope: All user-visible UI, reports, dialogs, exports intended for human review, onboarding, help text, validation messages, alerts, and DuhGoods-specific modules.
Primary locale: **Arabic (Saudi Arabia)**
Direction: **RTL**
Internal code language: English.

## 1. Product rule

DuhGoods Finance Ledger is an Arabic-first desktop accounting application.

A release is not accepted if a normal user workflow exposes untranslated English UI text.

Internal identifiers, source code symbols, database column names, API field names, file formats, transaction IDs, hashes, paths, email addresses, URLs, currency codes, and machine-facing integration fields may remain English/ASCII when technically appropriate.

Do not translate code merely to make the source code Arabic.

## 2. Upstream facts to preserve

The upstream Frappe Books baseline already contains:

- `translations/ar.csv`.
- Arabic in `languageCodeMap`.
- Arabic in `RTL_LANGUAGES`.
- root application `dir` switching through `languageDirection`.
- `tailwindcss-rtl`.
- the existing tagged-template translation system (`t\`...\``).
- the translation generation script under `scripts/generateTranslations.ts`.

Preserve this architecture unless a change is demonstrably necessary.

Do not replace the translation engine with a new framework in Phase 1.

## 3. DuhGoods defaults

For the DuhGoods build:

- Default language: Arabic.
- Default locale: Saudi Arabia (`ar-SA` semantics).
- Default country: Saudi Arabia.
- Default currency: SAR.
- Root UI direction: RTL from first paint, including setup/database-selection screens.
- Do not briefly render LTR and then switch to RTL.
- Arabic must work before any company database exists.

Other upstream languages may remain internally supported, but the DuhGoods product must not depend on English fallback for a complete Arabic workflow.

## 4. Translation quality

Translations must be professional Modern Standard Arabic suitable for accounting software used in Saudi Arabia.

Reject:

- literal machine translation,
- broken grammar,
- colloquial wording,
- inconsistent terminology,
- untranslated English prose,
- spelling mistakes,
- duplicated meanings using different Arabic terms,
- Indian-specific accounting terminology shown to a Saudi user where it is irrelevant.

Prefer concise financial/accounting terminology over verbose explanatory prose.

## 5. Canonical accounting glossary

Use these translations consistently unless a later approved glossary revision changes them.

| English | Canonical Arabic |
|---|---|
| Accounting | المحاسبة |
| Account | الحساب |
| Chart of Accounts | دليل الحسابات |
| General Ledger | دفتر الأستاذ العام |
| Ledger Entry | قيد دفتر الأستاذ |
| Journal Entry | قيد يومية |
| Journal Entries | قيود اليومية |
| Trial Balance | ميزان المراجعة |
| Balance Sheet | قائمة المركز المالي |
| Profit and Loss | قائمة الدخل |
| Income | الإيرادات |
| Revenue | الإيرادات |
| Expense | المصروف |
| Expenses | المصروفات |
| Asset | أصل |
| Assets | الأصول |
| Liability | التزام |
| Liabilities | الالتزامات |
| Equity | حقوق الملكية |
| Debit | مدين |
| Credit | دائن |
| Accounts Receivable | الحسابات المدينة |
| Accounts Payable | الحسابات الدائنة |
| Sales | المبيعات |
| Purchases | المشتريات |
| Sales Invoice | فاتورة مبيعات |
| Purchase Invoice | فاتورة مشتريات |
| Payment | دفعة |
| Payments | المدفوعات |
| Refund | استرداد |
| Chargeback | اعتراض على عملية / استرداد قسري |
| Settlement | تسوية |
| Reconciliation | مطابقة |
| Reconciled | مطابق |
| Unreconciled | غير مطابق |
| Currency | العملة |
| Exchange Rate | سعر الصرف |
| Exchange Gain/Loss | أرباح/خسائر فروق العملة |
| Tax | الضريبة |
| VAT | ضريبة القيمة المضافة |
| Input VAT | ضريبة المدخلات |
| Output VAT | ضريبة المخرجات |
| Taxable Amount | المبلغ الخاضع للضريبة |
| Zero-rated | خاضع لنسبة الصفر |
| Export Sales | مبيعات التصدير |
| Domestic Sales | المبيعات المحلية |
| Tax Invoice | فاتورة ضريبية |
| Tax Summary | ملخص الضريبة |
| Fiscal Year | السنة المالية |
| Posting Date | تاريخ القيد |
| Outstanding Amount | المبلغ المستحق |
| Gross Amount | المبلغ الإجمالي |
| Net Amount | صافي المبلغ |
| Fee | رسوم |
| Payment Gateway Fees | رسوم بوابة الدفع |
| Bank Fees | الرسوم البنكية |
| Cash Flow | التدفق النقدي |
| Import | استيراد |
| Export | تصدير |
| Report | تقرير |
| Reports | التقارير |
| Dashboard | لوحة القيادة |
| Settings | الإعدادات |
| Review Required | يتطلب مراجعة |
| Warning | تحذير |
| Error | خطأ |
| Success | نجاح |
| English              | Canonical Arabic                |
| -------------------- | ------------------------------- |
| Accounting           | المحاسبة                        |
| Account              | الحساب                          |
| Chart of Accounts    | دليل الحسابات                   |
| General Ledger       | دفتر الأستاذ العام              |
| Ledger Entry         | قيد دفتر الأستاذ                |
| Journal Entry        | قيد يومية                       |
| Journal Entries      | قيود اليومية                    |
| Trial Balance        | ميزان المراجعة                  |
| Balance Sheet        | قائمة المركز المالي             |
| Profit and Loss      | قائمة الدخل                     |
| Income               | الإيرادات                       |
| Revenue              | الإيرادات                       |
| Expense              | المصروف                         |
| Expenses             | المصروفات                       |
| Asset                | أصل                             |
| Assets               | الأصول                          |
| Liability            | التزام                          |
| Liabilities          | الالتزامات                      |
| Equity               | حقوق الملكية                    |
| Debit                | مدين                            |
| Credit               | دائن                            |
| Accounts Receivable  | الحسابات المدينة                |
| Accounts Payable     | الحسابات الدائنة                |
| Sales                | المبيعات                        |
| Purchases            | المشتريات                       |
| Sales Invoice        | فاتورة مبيعات                   |
| Purchase Invoice     | فاتورة مشتريات                  |
| Payment              | دفعة                            |
| Payments             | المدفوعات                       |
| Refund               | استرداد                         |
| Chargeback           | اعتراض على عملية / استرداد قسري |
| Settlement           | تسوية                           |
| Reconciliation       | مطابقة                          |
| Reconciled           | مطابق                           |
| Unreconciled         | غير مطابق                       |
| Currency             | العملة                          |
| Exchange Rate        | سعر الصرف                       |
| Exchange Gain/Loss   | أرباح/خسائر فروق العملة         |
| Tax                  | الضريبة                         |
| VAT                  | ضريبة القيمة المضافة            |
| Input VAT            | ضريبة المدخلات                  |
| Output VAT           | ضريبة المخرجات                  |
| Taxable Amount       | المبلغ الخاضع للضريبة           |
| Zero-rated           | خاضع لنسبة الصفر                |
| Export Sales         | مبيعات التصدير                  |
| Domestic Sales       | المبيعات المحلية                |
| Tax Invoice          | فاتورة ضريبية                   |
| Tax Summary          | ملخص الضريبة                    |
| Fiscal Year          | السنة المالية                   |
| Posting Date         | تاريخ القيد                     |
| Outstanding Amount   | المبلغ المستحق                  |
| Gross Amount         | المبلغ الإجمالي                 |
| Net Amount           | صافي المبلغ                     |
| Fee                  | رسوم                            |
| Payment Gateway Fees | رسوم بوابة الدفع                |
| Bank Fees            | الرسوم البنكية                  |
| Cash Flow            | التدفق النقدي                   |
| Import               | استيراد                         |
| Export               | تصدير                           |
| Report               | تقرير                           |
| Reports              | التقارير                        |
| Dashboard            | لوحة القيادة                    |
| Settings             | الإعدادات                       |
| Review Required      | يتطلب مراجعة                    |
| Warning              | تحذير                           |
| Error                | خطأ                             |
| Success              | نجاح                            |

Glossary changes must be deliberate and documented. Do not allow the same accounting concept to use several Arabic labels across different screens.

## 6. RTL requirements

RTL support is structural, not cosmetic.

Required:

- navigation, sidebars, forms, modals, tables, filters, menus, tabs, pagination, breadcrumbs, toast notifications, charts, and report headers must behave correctly in RTL.
- use logical CSS properties/classes (`start/end`, `ms/me`, `ps/pe`) instead of hard-coded left/right where practical.
- arrows and directional affordances must represent the correct visual direction.
- mixed Arabic/Latin content must not visually reorder identifiers.

Technical/numeric fields that should normally remain LTR include:

- transaction IDs,
- order IDs,
- hashes,
- email addresses,
- URLs,
- filesystem paths,
- IBAN/account identifiers,
- API identifiers,
- source filenames,
- version strings.

Use directional isolation (`bdi`, `dir="ltr"`, CSS `unicode-bidi: isolate`, or an equivalent safe component) for mixed-direction values.

## 7. Numbers and money

For financial clarity:

- keep machine/financial digits as `0-9`.
- do not silently convert transaction IDs or amounts into Eastern Arabic digit glyphs.
- format monetary values consistently.
- preserve exact stored numeric values; localization affects display only.
- negative signs, decimals, thousands separators, currency codes/symbols, and percentages must remain unambiguous in RTL.

If Intl is used, prefer a Saudi Arabic locale configured for Latin digits where required by the financial UI.

## 8. Dates

- UI dates must be readable in Arabic and consistent.
- underlying stored dates remain machine-safe/ISO where already used.
- source transaction dates must never be changed merely for display.
- report exports must clearly distinguish display date from underlying transaction timestamp when needed.

## 9. Product and upstream names

During Phase 1, references to "Frappe Books" that are truly product branding should be identified in an audit.

Do not mechanically replace every occurrence in code.

User-visible branding may later become "DuhGoods Finance Ledger" under a dedicated rebranding task, while license/copyright notices and upstream attribution must remain legally intact.

## 10. Saudi-first cleanup

The upstream application contains India-oriented defaults and features.

Phase 1 must:

- change DuhGoods defaults from English/India/INR to Arabic/Saudi Arabia/SAR.
- hide or avoid exposing India-specific labels in normal Saudi workflows where they are not relevant.
- not delete upstream regional/accounting code merely for cleanup.
- keep regional removal/refactoring for a separate approved task.

## 11. Existing Arabic translation file

`translations/ar.csv` is a starting asset, **not an authority**.

It must be audited line by line for:

- mistranslations,
- spelling mistakes,
- inconsistent terminology,
- untranslated strings,
- obsolete strings,
- India-specific terms,
- placeholders/interpolation preservation,
- accidental changes to template placeholders.

Never change placeholder structure such as `${0}`, `${1}`, etc.

## 12. No user-visible hard-coded English

New user-visible strings must use the established translation mechanism.

Direct English literals that reach the UI are bugs.

Add automated checks where technically reasonable to detect:

- missing Arabic translation entries,
- empty Arabic translations,
- source and Arabic text being identical when the source is normal English prose,
- unwrapped obvious UI strings in Vue/TypeScript,
- invalid/missing interpolation placeholders.

False-positive allowlists are acceptable for:

- IDs,
- product names,
- standard abbreviations,
- technical codes,
- dates/examples,
- URLs/emails,
- file extensions,
- fonts,
- accounting/technical tokens explicitly approved.

## 13. Reports and printing

Arabic acceptance includes:

- screen reports,
- print preview,
- PDF output,
- CSV/XLSX/PDF reports intended for human review,
- table headers,
- totals,
- footers,
- filters/period labels.

Arabic text must not be clipped, reversed, disconnected, or overlap numeric columns.

Generated machine-import CSV fields do not need Arabic headers unless explicitly defined as a human-facing report.

## 14. Accessibility and usability

- focus order must remain logical in RTL.
- keyboard navigation must continue to work.
- tooltips/dialogs must not overflow.
- Arabic text must remain readable at supported zoom/display scales.
- dark mode and light mode must both remain usable.

## 15. Acceptance gates

Arabic Foundation is accepted only when all applicable checks pass:

1. Application starts RTL before a database is selected.
2. Setup wizard is Arabic.
3. Database selector is Arabic.
4. Main desk/navigation is Arabic.
5. Core accounting screens are Arabic.
6. Reports are Arabic.
7. Dialogs, toasts, errors, validation messages are Arabic.
8. No normal workflow exposes unapproved English prose.
9. Mixed-direction values remain visually correct.
10. Existing unit/integration/UI tests pass.
11. New localization tests pass.
12. `yarn script:translate -l ar` does not destroy approved translations.
13. Placeholder consistency is verified automatically.
14. Build succeeds on the project's supported Linux path.

## 16. Development discipline

- Work only on `build/duhgoods-finance-ledger`.
- Do not push directly to `master`.
- Small reviewable commits.
- Do not begin DuhGoods finance/import/VAT features before Arabic Foundation acceptance.
- Preserve upstream AGPL license notices and attribution.
- Do not add cloud telemetry, external translation APIs, or runtime translation services.
- Arabic translation must be committed and work fully offline.

## 17. Required Phase 1 deliverables

- Arabic-first/Saudi-first defaults.
- audited and corrected `translations/ar.csv`.
- RTL fixes required for core screens.
- automated localization validation.
- documented glossary.
- list of intentionally preserved English/technical tokens.
- exact changed-file list.
- test/build results.
- screenshots or UI-test evidence covering major Arabic screens if the environment supports them.

This document is the localization contract for all future DuhGoods Finance Ledger development.
