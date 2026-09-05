export * from './types.js';
export { designSchema, patterns } from './design.schema.js';
export { boardDefinitionSchema, componentDefinitionSchema } from './definition.schema.js';
export { validateDesignSchema, validateBoardDefinition, validateComponentDefinition, validateAgainst } from './validate.js';
export type { SchemaValidation } from './validate.js';
export { migrateDesign } from './migrate.js';
export type { MigrationResult } from './migrate.js';
