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

  t.test('Verify translations/ar.csv integrity & completeness', (st) => {
    const csvPath = path.resolve(__dirname, '../translations/ar.csv');
    st.ok(fs.existsSync(csvPath), 'translations/ar.csv exists');

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const rows = parseCSV(csvContent);
    st.ok(rows.length > 1000, `CSV contains ${rows.length} rows`);

    const emptyRows: string[] = [];
    const placeholderMismatches: string[] = [];
    const suspiciousIdentical: string[] = [];

    for (const [src, tr] of rows) {
      if (!tr || tr.trim() === '') {
        emptyRows.push(src);
      }

      const srcMatches = (src.match(/\$\{\d+\}/g) || []).sort();
      const trMatches = ((tr || '').match(/\$\{\d+\}/g) || []).sort();
      if (srcMatches.join(',') !== trMatches.join(',')) {
        placeholderMismatches.push(`Source: "${src}" | Translation: "${tr}"`);
      }

      // Check for untranslated normal English prose (where src == tr and not allowlisted)
      if (src === tr && !ALLOWLIST.has(src) && !/^\$\{?\d+\}?$/.test(src)) {
        // If it contains normal English alphabetical words, flag it
        if (/[a-zA-Z]{3,}/.test(src)) {
          suspiciousIdentical.push(src);
        }
      }
    }

    st.equal(emptyRows.length, 0, 'No empty translations in ar.csv');
    st.equal(
      placeholderMismatches.length,
      0,
      'No interpolation placeholder mismatches'
    );
    st.equal(
      suspiciousIdentical.length,
      0,
      `No unallowlisted identical English source/translation strings (Found: ${suspiciousIdentical
        .slice(0, 5)
        .join(', ')})`
    );
    st.end();
  });
});
