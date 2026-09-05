import type { DesignDocument } from '@breadboard-studio/schema';
import { SCHEMA_VERSION, migrateDesign, validateDesignSchema } from '@breadboard-studio/schema';
import { CATALOG_ID, CATALOG_VERSION } from '@breadboard-studio/catalog';
import { canonicalJson, sha256Hex } from './hash.js';

export function createEmptyDesign(name = '未命名项目'): DesignDocument {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    catalog_versions: { [CATALOG_ID]: CATALOG_VERSION },
    metadata: { name, revision: 0, created_at: now, updated_at: now },
    boards: [],
    components: [],
    wires: [],
    net_intents: [],
    constraints: []
  };
}

export function cloneDesign(design: DesignDocument): DesignDocument {
  return JSON.parse(JSON.stringify(design)) as DesignDocument;
}

/** Content hash ignoring revision bookkeeping and view state. */
export function designHash(design: DesignDocument): string {
  const { view: _view, ...rest } = design;
  const { revision: _revision, updated_at: _updated, ...metadata } = rest.metadata;
  return sha256Hex(canonicalJson({ ...rest, metadata }));
}

export interface LoadResult {
  ok: boolean;
  design?: DesignDocument;
  errors: { path: string; message: string }[];
}

/** Parse + migrate + schema-validate a design from JSON text or an object. Never silently drops content. */
export function loadDesign(input: string | unknown): LoadResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [{ path: '/', message: `JSON 解析失败：${(e as Error).message}` }] };
    }
  }
  const mig = migrateDesign(raw);
  if (!mig.ok) return { ok: false, errors: [{ path: '/schema_version', message: mig.error ?? 'unsupported version' }] };
  const v = validateDesignSchema(mig.doc);
  if (!v.ok || !v.value) return { ok: false, errors: v.issues.map((i) => ({ path: i.path, message: i.message })) };
  return { ok: true, design: v.value, errors: [] };
}

export function serializeDesign(design: DesignDocument): string {
  return JSON.stringify(design, null, 2) + '\n';
}
