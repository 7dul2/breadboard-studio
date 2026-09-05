import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from './types.js';

export interface MigrationResult {
  ok: boolean;
  doc?: unknown;
  from?: string;
  to?: string;
  error?: string;
}

/**
 * Upgrade older design documents to the current schema version.
 * Only "1.0" exists today; newer or unknown versions are rejected explicitly
 * rather than being guessed at.
 */
export function migrateDesign(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'design document must be a JSON object' };
  }
  const version = (input as { schema_version?: unknown }).schema_version;
  if (typeof version !== 'string') return { ok: false, error: 'schema_version missing' };
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(version)) {
    return { ok: false, from: version, to: SCHEMA_VERSION, error: `schema_version ${version} is not supported by this build (supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})` };
  }
  return { ok: true, doc: input, from: version, to: SCHEMA_VERSION };
}
