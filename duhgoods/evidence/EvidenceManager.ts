import { createHash } from 'crypto';

/**
 * Computes a deterministic SHA-256 hash over a raw data object.
 * Keys are sorted before serialisation to ensure field-order independence.
 */
export function computeEvidenceHash(raw: unknown): string {
  const canonical = stableStringify(raw);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Computes a SHA-256 hash over raw bytes (e.g. the original import file).
 */
export function computeFileHash(content: Buffer | string): string {
  const buf =
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(buf).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (k) =>
        JSON.stringify(k) +
        ':' +
        stableStringify((value as Record<string, unknown>)[k])
    );
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}
