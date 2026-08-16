/**
 * Language files are packaged into the binary, if
 * newer files are available (if internet available)
 * then those will replace the current file.
 *
 * Language files are fetched from the frappe/books repo
 * the language files before storage have a ISO timestamp
 * prepended to the file.
 *
 * This timestamp denotes the commit datetime, update of the file
 * takes place only if a new update has been pushed.
 */

import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { parseCSV } from 'utils/csvParser';
import { LanguageMap } from 'utils/types';
import fetch from 'node-fetch';

const VALENTINES_DAY = 1644796800000;

// Short timeout for the optional update-check call — startup must not hang
// if the network is slow or the GitHub API is unreachable. A failed update-
// check is harmless; the cached translation file is used instead.
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

// Reasonable timeout for required content fetches. These calls are only made
// when no translation file exists on disk; a generous budget avoids false
// "missing translation" errors on slow connections.
const CONTENT_FETCH_TIMEOUT_MS = 30_000;

// Test-only injection point. Never call in production code.
// Allows tests to supply a mock that returns controllable responses
// without making real network requests.
type MockFetchFn = (
  url: string,
  timeoutMs: number
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} | null>;
let _mockFetch: MockFetchFn | null = null;
export function _injectFetchForTest(fn: MockFetchFn) {
  _mockFetch = fn;
}
export function _resetFetchAfterTest() {
  _mockFetch = null;
}

export async function getLanguageMap(code: string): Promise<LanguageMap> {
  const contents = await getContents(code);
  return getMapFromCsv(contents);
}

function getMapFromCsv(csv: string): LanguageMap {
  const matrix = parseCSV(csv);
  const languageMap: LanguageMap = {};

  for (const row of matrix) {
    /**
     * Ignore lines that have no translations
     */
    if (!row[0] || !row[1]) {
      continue;
    }

    const source = row[0];
    const translation = row[1];
    const context = row[3];

    languageMap[source] = { translation };
    if (context?.length) {
      languageMap[source].context = context;
    }
  }

  return languageMap;
}

async function getContents(code: string) {
  let contents = await getContentsIfExists(code);
  if (contents.length === 0) {
    contents = (await fetchAndStoreFile(code)) || contents;
  } else {
    contents = (await getUpdatedContent(code, contents)) || contents;
  }

  if (!contents || contents.length === 0) {
    throwCouldNotFetchFile(code);
  }

  return contents;
}

async function getContentsIfExists(code: string): Promise<string> {
  const filePath = await getTranslationFilePath(code);
  if (!filePath) {
    return '';
  }

  return await fs.readFile(filePath, { encoding: 'utf-8' });
}

async function fetchAndStoreFile(code: string, date?: Date) {
  let contents = await fetchContentsFromApi(code);
  if (!contents) {
    contents = await fetchContentsFromRaw(code);
  }

  if (!date && contents) {
    date = await getLastUpdated(code);
  }

  if (contents) {
    contents = [date!.toISOString(), contents].join('\n');
    await storeFile(code, contents);
  }

  return contents ?? '';
}

async function fetchContentsFromApi(code: string) {
  const url = `https://api.github.com/repos/frappe/books/contents/translations/${code}.csv`;
  const res = await errorHandledFetch(url, CONTENT_FETCH_TIMEOUT_MS);
  if (res === null || res.status !== 200) {
    return null;
  }

  const resJson = (await res.json()) as { content: string };
  return Buffer.from(resJson.content, 'base64').toString();
}

async function fetchContentsFromRaw(code: string) {
  const url = `https://raw.githubusercontent.com/frappe/books/master/translations/${code}.csv`;
  const res = await errorHandledFetch(url, CONTENT_FETCH_TIMEOUT_MS);
  if (res === null || res.status !== 200) {
    return null;
  }

  return await res.text();
}

async function getUpdatedContent(code: string, contents: string) {
  const { shouldUpdate, date } = await shouldUpdateFile(code, contents);
  if (!shouldUpdate) {
    return contents;
  }

  return await fetchAndStoreFile(code, date);
}

async function shouldUpdateFile(code: string, contents: string) {
  const date = await getLastUpdated(code);
  const oldDate = new Date(contents.split('\n')[0]);
  const shouldUpdate = date > oldDate || +oldDate === VALENTINES_DAY;

  return { shouldUpdate, date };
}

async function getLastUpdated(code: string): Promise<Date> {
  const url = `https://api.github.com/repos/frappe/books/commits?path=translations%2F${code}.csv&page=1&per_page=1`;
  // Use the short update-check timeout — a slow or unreachable GitHub API
  // must not block renderer startup; the cached file is a safe fallback.
  const res = await errorHandledFetch(url, UPDATE_CHECK_TIMEOUT_MS);
  if (res === null || res.status !== 200) {
    return new Date(VALENTINES_DAY);
  }

  const resJson = (await res.json()) as {
    commit: { author: { date: string } };
  }[];
  try {
    return new Date(resJson[0].commit.author.date);
  } catch {
    return new Date(VALENTINES_DAY);
  }
}

async function getTranslationFilePath(code: string) {
  // process.resourcesPath is only defined in Electron; guard for test/dev environments.
  let filePath = process.resourcesPath
    ? path.join(process.resourcesPath, `../translations/${code}.csv`)
    : '';

  if (filePath) {
    try {
      await fs.access(filePath, constants.R_OK);
    } catch {
      filePath = '';
    }
  }

  if (!filePath) {
    /**
     * This will be used in Development mode / test environments.
     */
    filePath = path.join(__dirname, `../../translations/${code}.csv`);
  }

  try {
    await fs.access(filePath, constants.R_OK);
  } catch {
    return '';
  }

  return filePath;
}

function throwCouldNotFetchFile(code: string) {
  throw new Error(`Could not fetch translations for '${code}'.`);
}

async function storeFile(code: string, contents: string) {
  const filePath = await getTranslationFilePath(code);
  if (!filePath) {
    return;
  }

  const dirname = path.dirname(filePath);
  await fs.mkdir(dirname, { recursive: true });
  await fs.writeFile(filePath, contents, { encoding: 'utf-8' });
}

async function errorHandledFetch(url: string, timeoutMs: number) {
  if (_mockFetch) {
    return _mockFetch(url, timeoutMs);
  }
  try {
    // node-fetch v2 has a built-in `timeout` option that aborts the request
    // via its own internal timer — more reliable than the native AbortController
    // in this Electron/Node environment.
    return await fetch(url, { timeout: timeoutMs });
  } catch {
    return null;
  }
}
