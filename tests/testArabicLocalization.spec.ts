import { parseCSV } from '../utils/csvParser';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_COUNTRY_CODE,
  DEFAULT_CURRENCY,
  DEFAULT_LANGUAGE,
  DEFAULT_LOCALE,
  RTL_LANGUAGES,
} from 'fyo/utils/consts';
import tape from 'tape';
import { discoverActiveSourceKeys } from 'utils/translationSourceDiscovery';

// Allowlist for legitimate technical tokens, product names, email/URL examples, and abbreviations
const ALLOWLIST = new Set([
  'SAR',
  'INR',
  'USD',
  'EUR',
  'PDF',
  'CSV',
  'XLSX',
  'ID',
  'URL',
  'HTTP',
  'HTTPS',
  'GSTIN',
  'HSN',
  'SAC',
  'POS',
  'ERPNext',
  'Frappe Books',
  'Inter',
  'Segoe UI',
  'Roboto',
  'Helvetica Neue',
  'Arial',
  'Times New Roman',
  '23 Mar, 2022',
  'HSN/SAC',
  'john@doe.com',
  'lin@lthings.com',
  'test@example.com',
  'http://localhost:3000',
  'http://',
  'https://',
]);

// Narrow list of known incorrect lexical/orthographic forms for quality regression check
const KNOWN_INCORRECT_PATTERNS = [
  /ايصال\s/i, // missing hamza in إيصال
  /ايصالات/i,
];

tape('Arabic Localization Validation Suite', (t) => {
  t.test('Assert clean-install defaults', (st) => {
    st.equal(DEFAULT_LANGUAGE, 'Arabic', 'DEFAULT_LANGUAGE is Arabic');
    st.equal(DEFAULT_COUNTRY_CODE, 'sa', 'DEFAULT_COUNTRY_CODE is sa');
    st.equal(DEFAULT_CURRENCY, 'SAR', 'DEFAULT_CURRENCY is SAR');
    st.equal(DEFAULT_LOCALE, 'ar-SA', 'DEFAULT_LOCALE is ar-SA');
    st.ok(
      RTL_LANGUAGES.includes('Arabic'),
      'Arabic is included in RTL_LANGUAGES'
    );
    st.end();
  });

  t.test(
    'Verify translations/ar.csv integrity & completeness against ACTIVE_SOURCE_KEYS',
    async (st) => {
      const csvPath = path.resolve(__dirname, '../translations/ar.csv');
      st.ok(fs.existsSync(csvPath), 'translations/ar.csv exists');

      const repoRoot = path.resolve(__dirname, '..');
      const activeSourceKeys = await discoverActiveSourceKeys(repoRoot);
      st.ok(
        activeSourceKeys.length > 500,
        `Discovered ${activeSourceKeys.length} active source keys`
      );

      const csvContent = fs.readFileSync(csvPath, 'utf8');
      const rows = parseCSV(csvContent);
      st.ok(rows.length > 1000, `CSV contains ${rows.length} rows`);

      const keyMap = new Map<string, string>();
      const duplicateKeys: string[] = [];
      const missingRows: string[] = [];
      const emptyRows: string[] = [];
      const placeholderMismatches: string[] = [];
      const suspiciousIdentical: string[] = [];
      const whitespaceIssues: string[] = [];
      const duplicateInternalSpaces: string[] = [];
      const incorrectLexicalForms: string[] = [];
      let allowlistedCount = 0;

      for (const [src, tr] of rows) {
        if (!src && src !== '') {
          missingRows.push('(null or undefined source key)');
          continue;
        }

        if (keyMap.has(src)) {
          duplicateKeys.push(
            `Key: "${src}" | Existing: "${keyMap.get(src)}" | New: "${tr}"`
          );
        } else {
          keyMap.set(src, tr);
        }

        if (tr !== undefined && tr !== null) {
          if (tr.length > 0 && (tr.startsWith(' ') || tr.endsWith(' '))) {
            whitespaceIssues.push(`Key: "${src}" | Translation: "${tr}"`);
          }
          if (/[\u0600-\u06FF]\s{2,}[\u0600-\u06FF]/.test(tr)) {
            duplicateInternalSpaces.push(
              `Key: "${src}" | Translation: "${tr}"`
            );
          }
          for (const pattern of KNOWN_INCORRECT_PATTERNS) {
            if (pattern.test(tr)) {
              incorrectLexicalForms.push(
                `Key: "${src}" | Translation: "${tr}"`
              );
              break;
            }
          }
        }
      }

      // Active source key coverage checks
      const missingActiveKeys: string[] = [];
      const emptyActiveTranslations: string[] = [];
      let translatedActiveCount = 0;

      for (const srcKey of activeSourceKeys) {
        if (!keyMap.has(srcKey)) {
          missingActiveKeys.push(srcKey);
        } else {
          const tr = keyMap.get(srcKey)!;
          if (!tr || tr.trim() === '') {
            emptyActiveTranslations.push(srcKey);
          } else {
            translatedActiveCount++;
          }
        }
      }

      for (const [src, tr] of keyMap.entries()) {
        if (!tr || tr.trim() === '') {
          emptyRows.push(src);
        }

        const srcMatches = (src.match(/\$\{\d+\}/g) || []).sort();
        const trMatches = ((tr || '').match(/\$\{\d+\}/g) || []).sort();
        if (srcMatches.join(',') !== trMatches.join(',')) {
          placeholderMismatches.push(`Source: "${src}" | Translation: "${tr}"`);
        }

        if (src === tr) {
          if (ALLOWLIST.has(src) || /^\$\{?\d+\}?$/.test(src)) {
            allowlistedCount++;
          } else if (/[a-zA-Z]{3,}/.test(src)) {
            suspiciousIdentical.push(src);
          }
        }
      }

      const extraArabicKeysCount = Math.max(
        0,
        keyMap.size - activeSourceKeys.length
      );

      /* eslint-disable no-console */
      console.log(`ACTIVE TRANSLATION SOURCE AUDIT:`);
      console.log(`Active source keys: ${activeSourceKeys.length}`);
      console.log(`Arabic rows: ${rows.length}`);
      console.log(`Unique Arabic keys: ${keyMap.size}`);
      console.log(`Translated active keys: ${translatedActiveCount}`);
      console.log(`Missing active keys: ${missingActiveKeys.length}`);
      console.log(
        `Empty active translations: ${emptyActiveTranslations.length}`
      );
      console.log(`Duplicate keys: ${duplicateKeys.length}`);
      console.log(`Placeholder mismatches: ${placeholderMismatches.length}`);
      console.log(
        `Suspicious untranslated English: ${suspiciousIdentical.length}`
      );
      console.log(`Allowlisted technical values: ${allowlistedCount}`);
      console.log(`Extra/obsolete Arabic keys: ${extraArabicKeysCount}`);
      /* eslint-enable no-console */

      st.equal(
        missingActiveKeys.length,
        0,
        `No missing active keys in ar.csv (Found: ${missingActiveKeys.length})`
      );
      st.equal(
        emptyActiveTranslations.length,
        0,
        `No empty active translations (Found: ${emptyActiveTranslations.length})`
      );
      st.equal(missingRows.length, 0, 'No missing rows in ar.csv');
      st.equal(
        duplicateKeys.length,
        0,
        `No duplicate source keys in ar.csv (Found: ${duplicateKeys.length})`
      );
      st.equal(emptyRows.length, 0, 'No empty translations in ar.csv');
      st.equal(
        placeholderMismatches.length,
        0,
        'No interpolation placeholder mismatches'
      );
      st.equal(
        whitespaceIssues.length,
        0,
        `No leading/trailing whitespace in translations (Found: ${whitespaceIssues.length})`
      );
      st.equal(
        duplicateInternalSpaces.length,
        0,
        `No duplicate internal spaces in Arabic prose (Found: ${duplicateInternalSpaces.length})`
      );
      st.equal(
        incorrectLexicalForms.length,
        0,
        `No known incorrect lexical forms found (Found: ${incorrectLexicalForms.length})`
      );
      st.equal(
        suspiciousIdentical.length,
        0,
        `No unallowlisted identical English source/translation strings (Found: ${suspiciousIdentical
          .slice(0, 5)
          .join(', ')})`
      );
      st.end();
    }
  );
});
