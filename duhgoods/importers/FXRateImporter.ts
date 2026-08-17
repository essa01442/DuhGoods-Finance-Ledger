import type { ImportAdapter, ImportedTransaction } from './types';

/**
 * Adapter stub for FX rate import.
 *
 * FX rates are not transaction evidence — they are rate evidence.
 * They are imported via FXService.importFromJSON() directly, not through
 * the ImportOrchestrator. This adapter exists for profile compatibility
 * (so an FX import profile can reference sourceType='fx_rates') but
 * parse() returns an empty array since storage is handled separately.
 */
export class FXRateImporter implements ImportAdapter {
  readonly sourceType = 'manual' as const;

  parse(_input: string | Buffer): ImportedTransaction[] {
    return [];
  }
}
