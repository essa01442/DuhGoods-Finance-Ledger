import fs from 'fs/promises';
import path from 'path';
import { generateCSV, parseCSV } from '../utils/csvParser';
import { discoverActiveSourceKeys } from '../utils/translationSourceDiscovery';

/* eslint-disable no-console, @typescript-eslint/no-floating-promises */

const translationsFolder = path.resolve(__dirname, '..', 'translations');

function printHelp() {
  const shouldPrint = process.argv.findIndex((i) => i === '-h') !== -1;
  if (shouldPrint) {
    console.log(
      `Usage: ` +
        `\tyarn script:translate\n` +
        `\tyarn script:translate -h\n` +
        `\tyarn script:translate -l [language_code]\n` +
        `\n` +
        `Example: $ yarn script:translate -l de\n` +
        `\n` +
        `Description:\n` +
        `\tPassing a language code will create a '.csv' file in\n` +
        `\tthe 'translations' subdirectory. Translated strings are to\n` +
        `\tbe added to this file.\n\n` +
        `\tCalling the script without args will update the translation csv\n` +
        `\tfile with new strings if any. Existing translations won't\n` +
        `\tbe removed.\n` +
        `\n` +
        `Parameters:\n` +
        `\tlanguage_code : An ISO 693-1 code or a locale identifier.\n` +
        `\n` +
        `Reference:\n` +
        `\tISO 693-1 codes: https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes\n` +
        `\tLocale identifier: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl#locale_identification_and_negotiation`
    );
  }
  return shouldPrint;
}

function getLanguageCode() {
  const i = process.argv.findIndex((i) => i === '-l');
  if (i === -1) {
    return '';
  }
  return process.argv[i + 1] ?? '';
}

function getTranslationFilePath(languageCode: string) {
  return path.resolve(translationsFolder, `${languageCode}.csv`);
}

async function regenerateTranslation(tArray: string[], path: string) {
  // Removes old strings, adds new strings
  const storedCSV = await fs.readFile(path, { encoding: 'utf-8' });
  const storedMatrix = parseCSV(storedCSV);

  const map: Map<string, string[]> = new Map();
  for (const row of storedMatrix) {
    const tstring = row[0];
    map.set(tstring, row.slice(1));
  }

  const matrix = tArray.map((source) => {
    const stored = map.get(source) ?? [];
    const translation = stored[0] ?? '';
    const context = stored[1] ?? '';

    return [source, translation, context];
  });
  const csv = generateCSV(matrix);

  await fs.writeFile(path, csv, { encoding: 'utf-8' });
  console.log(`\tregenerated: ${path}`);
}

async function regenerateTranslations(languageCode: string, tArray: string[]) {
  // regenerate one file
  if (languageCode.length !== 0) {
    const path = getTranslationFilePath(languageCode);
    await regenerateTranslation(tArray, path);
    return;
  }

  // regenerate all translation files
  console.log(`Language code not passed, regenerating all translations.`);
  for (const filePath of await fs.readdir(translationsFolder)) {
    if (!filePath.endsWith('.csv')) {
      continue;
    }

    await regenerateTranslation(
      tArray,
      path.resolve(translationsFolder, filePath)
    );
  }
}

async function writeTranslations(languageCode: string, tArray: string[]) {
  const path = getTranslationFilePath(languageCode);
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) {
      throw new Error(`${path} is not a translation file`);
    }

    console.log(
      `Existing file found for '${languageCode}': ${path}\n` +
        `regenerating it's translations.`
    );
    await regenerateTranslations(languageCode, tArray);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }

    const matrix = tArray.map((s) => [s, '', '']);
    const csv = generateCSV(matrix);
    await fs.writeFile(path, csv, { encoding: 'utf-8' });
    console.log(`Generated translation file for '${languageCode}': ${path}`);
  }
}

async function run() {
  if (printHelp()) {
    return;
  }

  const root = path.resolve(__dirname, '..');
  const languageCode = getLanguageCode();

  console.log();
  const tArray: string[] = await discoverActiveSourceKeys(root);

  try {
    await fs.stat(translationsFolder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }

    await fs.mkdir(translationsFolder);
  }

  if (languageCode === '') {
    await regenerateTranslations('', tArray);
    return;
  }

  await writeTranslations(languageCode, tArray);
}

run();
