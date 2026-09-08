import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from './types.js';

export interface MigrationResult {
  ok: boolean;
  doc?: unknown;
  /** Version the input declared. */
  from?: string;
  /** Version of `doc` after migration (always SCHEMA_VERSION on success). */
  to?: string;
  /** True when at least one migration step ran. */
  migrated?: boolean;
  error?: string;
}

type Doc = Record<string, unknown>;

/**
 * One step per supported older version. Each step must be lossless: it may
 * only add defaults or rename fields, never drop content.
 */
const STEPS: Record<string, { to: string; run: (doc: Doc) => Doc }> = {
  // 1.0 → 1.1: `programs` and `simulation` became optional top-level sections.
  // Existing files have neither, so the document itself is unchanged.
  '1.0': { to: '1.1', run: (doc) => ({ ...doc, schema_version: '1.1' }) }
};

/**
 * Upgrade older design documents to the current schema version. Unknown or
 * newer versions are rejected explicitly rather than being guessed at. The
 * input object is never mutated.
 */
export function migrateDesign(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'design document must be a JSON object' };
  }
  const from = (input as { schema_version?: unknown }).schema_version;
  if (typeof from !== 'string') return { ok: false, error: 'schema_version missing' };
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(from)) {
    return { ok: false, from, to: SCHEMA_VERSION, error: `schema_version ${from} is not supported by this build (supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})` };
  }
  let doc = input as Doc;
  let version = from;
  const seen = new Set<string>();
  while (version !== SCHEMA_VERSION) {
    const step = STEPS[version];
    if (!step || seen.has(version)) return { ok: false, from, to: SCHEMA_VERSION, error: `no migration path from schema_version ${version} to ${SCHEMA_VERSION}` };
    seen.add(version);
    doc = step.run(doc);
    version = step.to;
  }
  return { ok: true, doc, from, to: SCHEMA_VERSION, migrated: from !== SCHEMA_VERSION };
}
