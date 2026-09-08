import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { designSchema } from './design.schema.js';
import { boardDefinitionSchema, componentDefinitionSchema } from './definition.schema.js';
import type { BoardDefinition, ComponentDefinition, DesignDocument, SchemaIssue } from './types.js';
import { SUPPORTED_SCHEMA_VERSIONS } from './types.js';

let ajv: Ajv2020 | null = null;
let designValidator: ValidateFunction | null = null;
let boardValidator: ValidateFunction | null = null;
let componentValidator: ValidateFunction | null = null;

function getAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
  }
  return ajv;
}

function toIssues(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
    keyword: e.keyword
  }));
}

export interface SchemaValidation<T> {
  ok: boolean;
  issues: SchemaIssue[];
  value?: T;
}

/**
 * Structural validation of a design document against the JSON Schema plus the
 * schema_version whitelist. Does NOT check references or geometry.
 */
export function validateDesignSchema(doc: unknown): SchemaValidation<DesignDocument> {
  if (!designValidator) designValidator = getAjv().compile(designSchema);
  const issues: SchemaIssue[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, issues: [{ path: '/', message: 'design document must be a JSON object' }] };
  }
  const version = (doc as { schema_version?: unknown }).schema_version;
  if (typeof version !== 'string') {
    issues.push({ path: '/schema_version', message: 'schema_version is required and must be a string' });
  } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(version)) {
    issues.push({
      path: '/schema_version',
      message: `unsupported schema_version "${version}"; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      keyword: 'schema_version'
    });
    return { ok: false, issues };
  }
  const valid = designValidator(doc);
  if (!valid) issues.push(...toIssues(designValidator.errors));
  if (issues.length) return { ok: false, issues };
  return { ok: true, issues: [], value: doc as DesignDocument };
}

export function validateBoardDefinition(def: unknown): SchemaValidation<BoardDefinition> {
  if (!boardValidator) boardValidator = getAjv().compile(boardDefinitionSchema);
  const valid = boardValidator(def);
  if (!valid) return { ok: false, issues: toIssues(boardValidator.errors) };
  return { ok: true, issues: [], value: def as BoardDefinition };
}

/**
 * Semantic checks the JSON Schema cannot express: every simulation binding must
 * point at a feature and a pin that exist in the same definition, otherwise the
 * hit-test and overlay code would silently find nothing at runtime.
 */
function simulationIssues(def: ComponentDefinition): SchemaIssue[] {
  const sim = def.simulation;
  if (!sim) return [];
  const issues: SchemaIssue[] = [];
  const labels = new Set((def.features ?? []).map((f) => f.label).filter((l): l is string => !!l));
  // Parametric definitions generate their pins, so pin_meta is the authoritative name list there.
  const pinNames = new Set(def.pins.length ? def.pins.map((p) => p.name) : Object.keys(def.pin_meta ?? {}));
  const bindings = [...(sim.controls ?? []).map((c, i) => ({ path: `/simulation/controls/${i}`, b: c })), ...(sim.visuals ?? []).map((v, i) => ({ path: `/simulation/visuals/${i}`, b: v }))];
  for (const { path, b } of bindings) {
    if (!labels.has(b.feature_label)) {
      issues.push({ path: `${path}/feature_label`, message: `"${b.feature_label}" 不是该定义 features[].label 中的标签（可用：${[...labels].join('、') || '无'}）`, keyword: 'simulation' });
    }
  }
  const ids = bindings.map(({ b }) => b.id);
  for (const [i, id] of ids.entries()) {
    if (ids.indexOf(id) !== i) issues.push({ path: `${bindings[i]!.path}/id`, message: `重复的绑定 id "${id}"`, keyword: 'simulation' });
  }
  for (const pin of Object.keys(sim.pins ?? {})) {
    if (!pinNames.has(pin)) issues.push({ path: `/simulation/pins/${pin}`, message: `"${pin}" 不是该定义的引脚名`, keyword: 'simulation' });
  }
  return issues;
}

export function validateComponentDefinition(def: unknown): SchemaValidation<ComponentDefinition> {
  if (!componentValidator) componentValidator = getAjv().compile(componentDefinitionSchema);
  const valid = componentValidator(def);
  if (!valid) return { ok: false, issues: toIssues(componentValidator.errors) };
  const issues = simulationIssues(def as ComponentDefinition);
  if (issues.length) return { ok: false, issues };
  return { ok: true, issues: [], value: def as ComponentDefinition };
}

/** Validate arbitrary JSON against an inline schema (used for component params/config). */
export function validateAgainst(schema: Record<string, unknown>, value: unknown): SchemaIssue[] {
  const v = getAjv().compile(schema);
  const ok = v(value);
  return ok ? [] : toIssues(v.errors);
}
