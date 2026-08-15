import fs from 'fs/promises';
import path from 'path';
import { UnknownMap } from 'utils/types';
import {
  getIndexFormat,
  getWhitespaceSanitized,
  schemaTranslateables,
} from './translationHelpers';

const BACKTICK = '`';
const PATTERN = new RegExp(
  '(?<!\\w)t' + BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK,
  'g'
);

export type Content = { fileName: string; content: string };

export function shouldIgnore(p: string, ignoreList: string[]): boolean {
  const name = p.split(path.sep).at(-1) ?? '';
  return ignoreList.includes(name);
}

export async function getFileList(
  root: string,
  ignoreList: string[],
  extPattern = /\.(js|ts|vue)$/
): Promise<string[]> {
  const contents: string[] = await fs.readdir(root);
  const files: string[] = [];
  const promises: Promise<void>[] = [];

  for (const c of contents) {
    const absPath = path.resolve(root, c);
    const isDir = (await fs.stat(absPath)).isDirectory();

    if (isDir && !shouldIgnore(absPath, ignoreList)) {
      const pr = getFileList(absPath, ignoreList, extPattern).then((fl) => {
        files.push(...fl);
      });
      promises.push(pr);
    } else if (absPath.match(extPattern) !== null) {
      files.push(absPath);
    }
  }

  await Promise.all(promises);
  return files;
}

export async function getFileContents(fileList: string[]): Promise<Content[]> {
  const contents: Content[] = [];
  const promises: Promise<void>[] = [];
  for (const fileName of fileList) {
    const pr = fs.readFile(fileName, { encoding: 'utf-8' }).then((content) => {
      contents.push({ fileName, content });
    });
    promises.push(pr);
  }
  await Promise.all(promises);
  return contents;
}

export function tStringFinder(content: string): string[] {
  return [...content.matchAll(PATTERN)].map(([, t]) => {
    t = getIndexFormat(t);
    return getWhitespaceSanitized(t);
  });
}

export function getTStrings(content: string): Promise<string[]> {
  return new Promise((resolve) => {
    const tStrings = tStringFinder(content);
    resolve(tStrings);
  });
}

export async function getAllTStringsMap(
  contents: Content[]
): Promise<Map<string, string[]>> {
  const strings: Map<string, string[]> = new Map();
  const promises: Promise<void>[] = [];

  contents.forEach(({ fileName, content }) => {
    const pr = getTStrings(content).then((ts) => {
      if (ts.length === 0) {
        return;
      }
      strings.set(fileName, ts);
    });
    promises.push(pr);
  });

  await Promise.all(promises);
  return strings;
}

export function tStringsToArray(
  tMap: Map<string, string[]>,
  tStrings: string[]
): string[] {
  const tSet: Set<string> = new Set();
  for (const k of tMap.keys()) {
    tMap.get(k)!.forEach((s) => tSet.add(s));
  }

  for (const ts of tStrings) {
    tSet.add(ts);
  }

  return Array.from(tSet).sort();
}

export function pushTStringsFromSchema(
  map: UnknownMap | UnknownMap[],
  array: string[],
  translateables: string[]
) {
  if (Array.isArray(map)) {
    for (const item of map) {
      pushTStringsFromSchema(item, array, translateables);
    }
    return;
  }

  if (typeof map !== 'object') {
    return;
  }

  for (const key of Object.keys(map)) {
    const value = map[key];
    if (translateables.includes(key) && typeof value === 'string') {
      array.push(value);
    }

    if (typeof value !== 'object') {
      continue;
    }

    pushTStringsFromSchema(
      value as UnknownMap | UnknownMap[],
      array,
      translateables
    );
  }
}

export async function getTStringsFromJsonFileList(
  fileList: string[]
): Promise<string[]> {
  const promises: Promise<void>[] = [];
  const schemaTStrings: string[][] = [];

  for (const filePath of fileList) {
    const promise = fs
      .readFile(filePath, { encoding: 'utf8' })
      .then((content) => {
        const schema = JSON.parse(content) as Record<string, unknown>;
        const tStrings: string[] = [];
        pushTStringsFromSchema(schema, tStrings, schemaTranslateables);
        return tStrings;
      })
      .then((ts) => {
        schemaTStrings.push(ts);
      });

    promises.push(promise);
  }

  await Promise.all(promises);
  return schemaTStrings.flat();
}

export async function getSchemaTStrings(repoRoot: string) {
  const root = path.resolve(repoRoot, 'schemas');
  const fileList = await getFileList(root, ['tests', 'regional'], /\.json$/);
  return await getTStringsFromJsonFileList(fileList);
}

export async function discoverActiveSourceKeys(
  repoRoot: string
): Promise<string[]> {
  const ignoreList = ['node_modules', 'dist_electron', 'scripts'];
  const fileList: string[] = await getFileList(repoRoot, ignoreList);
  const contents: Content[] = await getFileContents(fileList);
  const tMap: Map<string, string[]> = await getAllTStringsMap(contents);
  const schemaTStrings: string[] = await getSchemaTStrings(repoRoot);
  return tStringsToArray(tMap, schemaTStrings);
}
