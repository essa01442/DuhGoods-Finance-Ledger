import { parseCSV } from '../utils/csvParser';
import fs from 'fs';
import path from 'path';
import { DEFAULT_COUNTRY_CODE, DEFAULT_CURRENCY, DEFAULT_LANGUAGE, DEFAULT_LOCALE, RTL_LANGUAGES } from 'fyo/utils/consts';
import tape from 'tape';

tape('Arabic Localization Validation Suite', (t) => {
  t.test('Assert clean-install defaults', (st) => {
    st.equal(DEFAULT_LANGUAGE, 'Arabic', 'DEFAULT_LANGUAGE is Arabic');
    st.equal(DEFAULT_COUNTRY_CODE, 'sa', 'DEFAULT_COUNTRY_CODE is sa');
    st.equal(DEFAULT_CURRENCY, 'SAR', 'DEFAULT_CURRENCY is SAR');
    st.equal(DEFAULT_LOCALE, 'ar-SA', 'DEFAULT_LOCALE is ar-SA');
    st.ok(RTL_LANGUAGES.includes('Arabic'), 'Arabic is included in RTL_LANGUAGES');
    st.end();
  });

  t.test('Verify translations/ar.csv integrity', (st) => {
    const csvPath = path.resolve(__dirname, '../translations/ar.csv');
    st.ok(fs.existsSync(csvPath), 'translations/ar.csv exists');

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const rows = parseCSV(csvContent);
    st.ok(rows.length > 1000, `CSV contains ${rows.length} rows`);

    const emptyRows: string[] = [];
    const placeholderMismatches: string[] = [];

    for (const [src, tr] of rows) {
      if (!tr || tr.trim() === '') {
        emptyRows.push(src);
      }

      const srcMatches = (src.match(/\$\{\d+\}/g) || []).sort();
      const trMatches = ((tr || '').match(/\$\{\d+\}/g) || []).sort();
      if (srcMatches.join(',') !== trMatches.join(',')) {
        placeholderMismatches.push(`Source: "${src}" | Translation: "${tr}"`);
      }
    }

    st.equal(emptyRows.length, 0, 'No empty translations in ar.csv');
    st.equal(placeholderMismatches.length, 0, 'No interpolation placeholder mismatches');
    st.end();
  });
});
