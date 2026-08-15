# Jules Task 001 — Arabic Foundation Audit and Implementation

Repository: `essa01442/DuhGoods-Finance-Ledger`
Branch: `build/duhgoods-finance-ledger`

Upstream baseline:

- Project: `frappe/books`
- Baseline master commit when the private repository was created:
  `7c35767811762e59573f62bfff936cb9e3016bda`
- Upstream package version: `0.37.0`

## Objective

Make Arabic/Saudi localization a first-class, testable foundation for DuhGoods Finance Ledger.

Do **not** start DuhGoods finance importers, payment reconciliation, Saudi VAT business logic, payment-gateway adapters, or dashboard feature work yet.

This task is Arabic Foundation only.

## Mandatory first step: read before editing

Study these files and surrounding code first:

- `translations/ar.csv`
- `fyo/utils/consts.ts`
- `fyo/utils/translation.ts`
- `src/utils/language.ts`
- `src/App.vue`
- `tailwind.config.js`
- `scripts/generateTranslations.ts`
- `utils/translationHelpers*`
- setup wizard components
- database selector components
- Desk/sidebar/navigation components
- report/list/table components
- print/report rendering code
- existing localization/i18n tests, if any

Also create/read:

- `docs/ARABIC_LOCALIZATION_STANDARD.md`

Treat that document as mandatory product policy.

## Facts already observed upstream

Do not waste time rediscovering these, but verify them in the branch:

1. Upstream already has `translations/ar.csv`.
2. Arabic is already mapped to `ar`.
3. `RTL_LANGUAGES` already includes Arabic.
4. `src/App.vue` already sets root `dir` using the selected language.
5. `tailwindcss-rtl` is already configured.
6. The upstream defaults are still English / India / INR.
7. The current Arabic CSV is not production-quality. Examples already observed include:
   - obvious typo: `مرطبت`
   - inconsistent/weak accounting terms
   - untranslated examples such as `23 Mar, 2022`
   - India-specific accounting terminology
   - awkward literal translations
   - inconsistent forms of accounting report names

Therefore: preserve and strengthen the existing i18n system; do not replace it without a documented, tested reason.

## Required implementation

### A. Establish Arabic/Saudi defaults

For the DuhGoods build, make clean-install defaults appropriate to:

- language: Arabic
- locale: Saudi Arabia
- country: Saudi Arabia
- currency: SAR
- RTL from the first rendered application screen

Do not introduce a visible LTR flash before Arabic is loaded.

Existing databases must not be silently corrupted or migrated to different financial values.

### B. Make Arabic translation complete and professional

Audit `translations/ar.csv` against the current generated translation source set.

Requirements:

- every normal user-visible English source string used in active app flows has a valid Arabic translation.
- fix spelling, grammar, accounting terminology, and consistency.
- preserve interpolation placeholders exactly.
- do not translate technical tokens that should remain unchanged.
- do not use machine-translation-quality Arabic.
- use Modern Standard Arabic appropriate for Saudi accounting software.
- obey the canonical glossary in `docs/ARABIC_LOCALIZATION_STANDARD.md`.

When unsure whether an accounting term should be changed, prefer consistency with the glossary and document any disputed term rather than inventing synonyms.

### C. RTL hardening

Audit and fix the major application paths:

- database selector
- setup wizard
- Desk/sidebar/navigation
- settings
- chart of accounts
- journal entries
- sales/purchase/payment screens that are still part of the upstream UI
- list/grid/table controls
- filters
- dialogs/toasts
- reports
- print preview

Use logical direction-aware layout.

Mixed Arabic/Latin values must remain readable.

Create a reusable LTR/directional-isolation treatment/component if the codebase needs one for:

- IDs
- hashes
- paths
- email
- URLs
- codes
- transaction identifiers
- bank/IBAN-like identifiers

Do not solve mixed-direction bugs by globally forcing entire tables to LTR.

### D. Add automated localization validation

Create tests/scripts that fail on real localization regressions.

At minimum validate:

1. Arabic translation CSV can be generated/loaded.
2. no empty Arabic translation for active normal UI source strings.
3. placeholders in source and Arabic translation match exactly.
4. approved Arabic defaults are asserted.
5. Arabic is recognized as RTL.
6. obvious normal-English source=translation cases are reported/fail unless allowlisted.
7. an allowlist exists for legitimate technical tokens/examples.

If practical, add a static audit for likely hard-coded user-visible English strings that bypass the translation helper. Keep false positives controlled; do not add a useless noisy check.

### E. Keep internal code English

Do not rename database schemas, TypeScript identifiers, APIs, or machine-facing keys to Arabic.

Arabic 100% means the user-facing product, not Arabic source code.

### F. Preserve upstream maintainability

Avoid broad unnecessary rewrites.

Keep changes modular so future upstream fixes can be cherry-picked/merged.

Do not delete upstream regional features in this task.

Do not remove license/copyright notices.

## Explicit non-goals

Do NOT:

- build WooCommerce import.
- build PSP adapters.
- implement reconciliation engine.
- implement Saudi VAT calculation/business logic.
- build DuhGoods finance dashboard.
- implement ZATCA submission.
- add cloud services.
- add telemetry.
- create user accounts.
- change accounting mathematics.
- change double-entry semantics.
- rewrite SQLite/accounting core.
- merge to `master`.

## Required tests

Run the strongest applicable existing test suite plus:

- translation generation/check for Arabic.
- new Arabic validation tests.
- lint/type checks.
- production build.
- any existing UI tests that can run in the environment.

If an upstream test is already broken, separate it clearly from your changes and provide evidence.

## Required output

Finish with:

1. summary of architecture findings.
2. exact changed-file list.
3. Arabic translation validation statistics:
   - total active source strings
   - translated
   - intentionally allowlisted
   - missing
   - placeholder mismatches
4. RTL issues found and fixed.
5. tests run with exact results.
6. remaining known Arabic/RTL gaps, if any.
7. commit SHA(s).

Stop after Arabic Foundation work.

Do not begin the next feature phase.
