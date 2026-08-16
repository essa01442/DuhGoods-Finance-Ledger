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

export interface IdentityKeyOpts {
  sourceType: string;
  sourceNamespace: string;
  /**
   * The source system's own external transaction reference.
   * Set to '' for reference-less rows (e.g. bank statements with no ref field).
   * When empty, sourceFileHash + rowLocator are used instead.
   */
  externalSourceId: string;
  /** SHA-256 of the original import file bytes — required when externalSourceId is ''. */
  sourceFileHash?: string;
  /** Zero-based row position within the import file — required when externalSourceId is ''. */
  rowLocator?: number;
}

/**
 * Derives the identity key for a transaction record.
 *
 * WITH external reference:
 *   identityKey = SHA-256(sourceType\x00sourceNamespace\x00externalSourceId)
 *
 * WITHOUT external reference (reference-less rows):
 *   identityKey = SHA-256(sourceType\x00sourceNamespace\x00sourceFileHash\x00rowLocator)
 *
 * This prevents four collision classes:
 *   A. Same external ref from different accounts (different sourceNamespace)
 *   B. Different source types sharing an external ref (different sourceType)
 *   C. Same row position in different import files (different sourceFileHash)
 *   D. Same external ref in same account appearing in two source types
 */
export function computeIdentityKey(opts: IdentityKeyOpts): string {
  const { sourceType, sourceNamespace, externalSourceId } = opts;
  const NUL = '\x00';

  if (externalSourceId) {
    return createHash('sha256')
      .update(
        `${sourceType}${NUL}${sourceNamespace}${NUL}${externalSourceId}`,
        'utf8'
      )
      .digest('hex');
  }

  const fileHash = opts.sourceFileHash ?? '';
  const rowLocator = String(opts.rowLocator ?? 0);
  return createHash('sha256')
    .update(
      `${sourceType}${NUL}${sourceNamespace}${NUL}${fileHash}${NUL}${rowLocator}`,
      'utf8'
    )
    .digest('hex');
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
