/**
 * JSON Schema (draft 2020-12) for `.breadboard.json` design documents, schema_version 1.0.
 * Structural rules only; geometry and electrical rules live in @breadboard-studio/core.
 */

const ID_PATTERN = '^[A-Za-z_][A-Za-z0-9_-]{0,63}$';
const HOLE_ADDRESS_PATTERN = '^[A-Za-z_][A-Za-z0-9_-]*\\.[A-Za-z0-9_+-]+$';
const MODEL_REF_PATTERN = '^[a-z0-9_]+@[0-9]+$';
const COLOR_PATTERN = '^(#[0-9a-fA-F]{6}|[a-z][a-z_-]{1,31})$';

const pointUm = {
  type: 'array',
  items: { type: 'integer', minimum: -100000000, maximum: 100000000 },
  minItems: 2,
  maxItems: 2
} as const;

const rotation = { type: 'integer', enum: [0, 90, 180, 270] } as const;

const endpointObject = {
  type: 'object',
  oneOf: [
    {
      properties: { hole: { type: 'string', pattern: HOLE_ADDRESS_PATTERN } },
      required: ['hole'],
      additionalProperties: false
    },
    {
      properties: { terminal: { type: 'string', pattern: HOLE_ADDRESS_PATTERN } },
      required: ['terminal'],
      additionalProperties: false
    }
  ]
} as const;

export const designSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breadboard-studio.dev/schema/design-1.0.json',
  title: 'Breadboard Studio design document',
  type: 'object',
  required: ['schema_version', 'catalog_versions', 'metadata', 'boards', 'components', 'wires', 'net_intents', 'constraints'],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+$' },
    catalog_versions: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },
    metadata: {
      type: 'object',
      required: ['name', 'revision'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string' },
        author: { type: 'string' },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        revision: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' }
      }
    },
    boards: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'model', 'position_um', 'rotation_deg'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID_PATTERN },
          name: { type: 'string' },
          model: { type: 'string', pattern: MODEL_REF_PATTERN },
          position_um: pointUm,
          rotation_deg: rotation,
          locked: { type: 'boolean' },
          notes: { type: 'string' }
        }
      }
    },
    components: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'model', 'placement'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID_PATTERN },
          name: { type: 'string' },
          model: { type: 'string', pattern: MODEL_REF_PATTERN },
          placement: {
            type: 'object',
            oneOf: [
              {
                properties: {
                  kind: { const: 'board' },
                  board_id: { type: 'string', pattern: ID_PATTERN },
                  anchor_hole: { type: 'string', pattern: '^[A-Za-z0-9_+-]+$' },
                  anchor_pin: { type: 'string', pattern: '^[A-Za-z0-9_+-]+$' },
                  rotation_deg: rotation
                },
                required: ['kind', 'board_id', 'anchor_hole', 'anchor_pin', 'rotation_deg'],
                additionalProperties: false
              },
              {
                properties: {
                  kind: { const: 'off_board' },
                  position_um: pointUm,
                  rotation_deg: rotation
                },
                required: ['kind', 'position_um', 'rotation_deg'],
                additionalProperties: false
              }
            ]
          },
          params: { type: 'object' },
          config: { type: 'object' },
          locked: { type: 'boolean' },
          color: { type: 'string', pattern: COLOR_PATTERN },
          notes: { type: 'string' }
        }
      }
    },
    wires: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'from', 'color', 'route', 'path_mode', 'waypoints_um'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID_PATTERN },
          name: { type: 'string' },
          from: endpointObject,
          to: endpointObject,
          color: { type: 'string', pattern: COLOR_PATTERN },
          route: { type: 'string', enum: ['flat', 'elevated'] },
          path_mode: { type: 'string', enum: ['auto', 'manual'] },
          waypoints_um: { type: 'array', items: pointUm, maxItems: 64 },
          locked: { type: 'boolean' },
          notes: { type: 'string' }
        }
      }
    },
    net_intents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'endpoints'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID_PATTERN },
          name: { type: 'string', minLength: 1 },
          endpoints: { type: 'array', items: { type: 'string', pattern: HOLE_ADDRESS_PATTERN }, minItems: 1 },
          notes: { type: 'string' }
        }
      }
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type'],
        oneOf: [
          {
            properties: {
              id: { type: 'string', pattern: ID_PATTERN },
              type: { const: 'isolate' },
              a: { type: 'string', pattern: HOLE_ADDRESS_PATTERN },
              b: { type: 'string', pattern: HOLE_ADDRESS_PATTERN },
              notes: { type: 'string' }
            },
            required: ['id', 'type', 'a', 'b'],
            additionalProperties: false
          },
          {
            properties: {
              id: { type: 'string', pattern: ID_PATTERN },
              type: { const: 'wire_length_max_um' },
              max_um: { type: 'integer', minimum: 1 },
              wire_ids: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' }
            },
            required: ['id', 'type', 'max_um'],
            additionalProperties: false
          },
          {
            properties: {
              id: { type: 'string', pattern: ID_PATTERN },
              type: { const: 'note' },
              text: { type: 'string' },
              notes: { type: 'string' }
            },
            required: ['id', 'type', 'text'],
            additionalProperties: false
          }
        ]
      }
    },
    embedded_catalog: {
      type: 'object',
      additionalProperties: false,
      properties: {
        boards: { type: 'array', items: { type: 'object' } },
        components: { type: 'array', items: { type: 'object' } }
      }
    },
    view: {
      type: 'object',
      additionalProperties: false,
      properties: {
        zoom: { type: 'number', exclusiveMinimum: 0 },
        center_um: pointUm,
        show_hole_labels: { type: 'boolean' },
        show_pin_labels: { type: 'boolean' },
        build_done: { type: 'array', items: { type: 'string' } }
      }
    }
  }
} as const;

export const patterns = { ID_PATTERN, HOLE_ADDRESS_PATTERN, MODEL_REF_PATTERN, COLOR_PATTERN };
