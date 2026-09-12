/**
 * JSON Schema (draft 2020-12) for catalog definitions (boards and components).
 * Used for the built-in catalog, embedded catalogs inside designs, and user imports.
 */

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } as const;
const status = { type: 'string', enum: ['verified', 'approximate', 'unknown'] } as const;
const evidence = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false,
    required: ['facet', 'level', 'source_url', 'scope', 'method', 'result', 'recorded_at'],
    properties: {
      facet: { enum: ['geometry', 'electrical'] }, level: { enum: ['documented', 'measured'] },
      source_url: { type: 'string', pattern: '^https?://[^\\s]+$' },
      scope: { type: 'string', pattern: '\\S' }, method: { type: 'string', pattern: '\\S' },
      result: { type: 'string', pattern: '\\S' }, recorded_at: { type: 'string', format: 'date' },
      reviewer: { type: 'string', pattern: '\\S' }, reviewed_at: { type: 'string', format: 'date' }
    }
  }
} as const;
const sources = {
  type: 'array',
  items: {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' }, url: { type: 'string' }, accessed: { type: 'string' }, note: { type: 'string' } },
    additionalProperties: false
  }
} as const;
const license = {
  type: 'object',
  required: ['spdx'],
  properties: { spdx: { type: 'string' }, attribution: { type: 'string' }, note: { type: 'string' } },
  additionalProperties: false
} as const;

export const boardDefinitionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breadboard-studio.dev/schema/board-definition-1.json',
  type: 'object',
  required: ['kind', 'id', 'version', 'name', 'size_um', 'pitch_um', 'terminal_blocks', 'rails', 'ravines', 'render', 'geometry_status', 'electrical_status', 'sources', 'license'],
  additionalProperties: false,
  properties: {
    kind: { const: 'board' },
    id: { type: 'string', pattern: '^[a-z0-9_]+$' },
    version: { type: 'integer', minimum: 1 },
    name: { type: 'string' },
    manufacturer: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    description: { type: 'string' },
    size_um: point,
    pitch_um: { type: 'integer', minimum: 1 },
    terminal_blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'rows', 'first_column', 'columns', 'origin_um'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          rows: { type: 'array', items: { type: 'string', pattern: '^[a-z]$' }, minItems: 1 },
          first_column: { type: 'integer', minimum: 1 },
          columns: { type: 'integer', minimum: 1 },
          origin_um: point
        }
      }
    },
    rails: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'holes', 'origin_um', 'group_size', 'gap_pitches', 'segments', 'marking', 'marking_color', 'marking_side'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z_]+$' },
          holes: { type: 'integer', minimum: 1 },
          origin_um: point,
          group_size: { type: 'integer', minimum: 1 },
          gap_pitches: { type: 'integer', minimum: 0 },
          segments: { type: 'array', items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 }, minItems: 1 },
          marking: { type: 'string', enum: ['+', '-', 'none'] },
          marking_color: { type: 'string' },
          marking_side: { type: 'string', enum: ['above', 'below'] }
        }
      }
    },
    ravines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['x_um', 'y_um', 'w_um', 'h_um'],
        additionalProperties: false,
        properties: { x_um: { type: 'number' }, y_um: { type: 'number' }, w_um: { type: 'number' }, h_um: { type: 'number' } }
      }
    },
    render: {
      type: 'object',
      required: ['body_color'],
      additionalProperties: false,
      properties: {
        body_color: { type: 'string' },
        edge_color: { type: 'string' },
        hole_color: { type: 'string' },
        label_color: { type: 'string' },
        corner_radius_um: { type: 'number' }
      }
    },
    evidence,
    geometry_status: status,
    electrical_status: status,
    status_notes: { type: 'string' },
    sources,
    license
  }
} as const;

const pinMeta = {
  type: 'object',
  required: ['role'],
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['power_in', 'power_out', 'ground', 'gpio', 'analog', 'i2c_sda', 'i2c_scl', 'signal_in', 'signal_out', 'passive', 'nc', 'unknown'] },
    voltage_v: { type: ['number', 'null'] },
    io_voltage_v: { type: ['number', 'null'] },
    direction: { type: 'string', enum: ['in', 'out', 'bidir', 'open_drain', 'passive', 'unknown'] },
    drive: { type: 'string', enum: ['push_pull', 'open_drain', 'unknown'] },
    max_source_ma: { type: ['number', 'null'] },
    aliases: { type: 'array', items: { type: 'string' } },
    auto_wire: { type: 'string', enum: ['default', 'avoid', 'skip', 'to_ground', 'to_power'] },
    multiplex: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['strapping', 'usb', 'jtag'] } },
    reserved: { type: 'string', enum: ['flash', 'psram'] },
    notes: { type: 'string' }
  }
} as const;

/** `extra` keys are required; `optional` keys are allowed but not demanded. */
const simulationBinding = (extra: Record<string, unknown>, optional: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    required: ['id', 'feature_label', 'channel', ...Object.keys(extra)],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]{0,63}$' },
      feature_label: { type: 'string', minLength: 1 },
      channel: { type: 'string', minLength: 1 },
      ...extra,
      ...optional
    }
  }) as const;

/** Simulator binding: which driver models the part and how features map to driver channels. */
const simulation = {
  type: 'object',
  required: ['driver'],
  additionalProperties: false,
  properties: {
    driver: { type: 'string', pattern: '^[a-z0-9_.-]+@[0-9]+$' },
    pins: { type: 'object', additionalProperties: { type: ['string', 'integer'] } },
    properties: { type: 'object' },
    controls: {
      type: 'array',
      items: simulationBinding(
        { action: { type: 'string', enum: ['press', 'touch', 'toggle', 'slider'] } },
        {
          range: {
            type: 'object',
            additionalProperties: false,
            required: ['min', 'max'],
            properties: { min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number', exclusiveMinimum: 0 }, default: { type: 'number' }, unit: { type: 'string' } }
          }
        }
      )
    },
    visuals: { type: 'array', items: simulationBinding({ kind: { type: 'string', enum: ['led', 'display', 'state'] } }) }
  }
} as const;

const renderPrimitive = {
  type: 'object',
  required: ['t'],
  properties: { t: { type: 'string', enum: ['rect', 'circle', 'text', 'path', 'line'] }, g: { type: 'string', description: '外观编辑器中的部件分组标签' } }
} as const;

export const componentDefinitionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breadboard-studio.dev/schema/component-definition-1.json',
  type: 'object',
  required: ['kind', 'id', 'version', 'name', 'category', 'mount', 'origin', 'body', 'pins', 'pin_meta', 'electrical', 'render', 'geometry_status', 'electrical_status', 'sources', 'license'],
  additionalProperties: false,
  properties: {
    kind: { const: 'component' },
    id: { type: 'string', pattern: '^[a-z0-9_]+$' },
    version: { type: 'integer', minimum: 1 },
    name: { type: 'string' },
    manufacturer: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string', enum: ['mcu', 'display', 'sensor', 'input', 'power', 'passive', 'connector', 'other'] },
    mount: { type: 'string', enum: ['breadboard', 'off_board'] },
    origin: { const: 'top_left' },
    preferred_rotation_deg: { type: 'integer', enum: [0, 90, 180, 270] },
    generator: {
      type: 'object',
      oneOf: [
        {
          properties: {
            type: { const: 'single_row_header' },
            edge: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
            inset_um: { type: 'number' }
          },
          required: ['type', 'edge', 'inset_um'],
          additionalProperties: false
        },
        {
          properties: { type: { const: 'dual_row_header' }, first_pin_um: { type: 'number' } },
          required: ['type', 'first_pin_um'],
          additionalProperties: false
        },
        {
          properties: { type: { const: 'axial_two_pin' } },
          required: ['type'],
          additionalProperties: false
        }
      ]
    },
    params_schema: { type: 'object' },
    params_default: { type: 'object' },
    config_schema: { type: 'object' },
    config_default: { type: 'object' },
    body: {
      type: 'object',
      required: ['size_um', 'height_um', 'standoff_um'],
      additionalProperties: false,
      properties: {
        size_um: point,
        height_um: { type: 'number', minimum: 0 },
        standoff_um: { type: 'number', minimum: 0 },
        corner_radius_um: { type: 'number' }
      }
    },
    pin_render: {
      type: 'object',
      required: ['shape'],
      additionalProperties: false,
      properties: {
        shape: { type: 'string', enum: ['rect', 'circle'] },
        show_labels: { type: 'boolean' },
        size_um: { type: 'number', minimum: 1 },
        fill: { type: 'string' },
        stroke: { type: 'string' },
        stroke_width_um: { type: 'number', minimum: 0 },
        hole_fill: { type: 'string' },
        hole_size_um: { type: 'number', minimum: 0 }
      }
    },
    pins: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'local_um', 'kind'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z0-9_+-]+$' },
          local_um: point,
          kind: { type: 'string', enum: ['header', 'terminal', 'pad'] }
        }
      }
    },
    pin_meta: { type: 'object', additionalProperties: pinMeta },
    internal_nets: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2 } },
    conduction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'pins'],
        properties: {
          kind: { type: 'string', enum: ['resistor'] },
          pins: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
          value_param: { type: 'string' }
        }
      }
    },
    electrical: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supply_voltage_v: {
          type: ['object', 'null'],
          properties: { min: { type: 'number' }, max: { type: 'number' } },
          required: ['min', 'max'],
          additionalProperties: false
        },
        supply_current_ma: {
          type: ['object', 'null'],
          properties: { typical: { type: ['number', 'null'] }, peak: { type: ['number', 'null'] } },
          additionalProperties: false
        },
        io_voltage_v: { type: ['number', 'null'] },
        i2c: {
          type: ['object', 'null'],
          required: ['sda_pin', 'scl_pin'],
          additionalProperties: false,
          properties: {
            pullups: {
              type: 'object', additionalProperties: false, required: ['state'],
              properties: {
                state: { enum: ['present', 'absent', 'unknown'] },
                supply_pin: { type: 'string', minLength: 1 },
                resistance_ohms: { type: 'number', exclusiveMinimum: 0 }
              },
              allOf: [{ if: { properties: { state: { const: 'present' } } }, then: { required: ['supply_pin'] } }]
            },
            address_default: { type: ['integer', 'null'] },
            address_options: { type: 'array', items: { type: 'integer' } },
            configurable: { type: 'boolean' },
            sda_pin: { type: 'string' },
            scl_pin: { type: 'string' },
            controllers: { type: 'integer', minimum: 1 },
            mappable: { type: 'boolean' },
            notes: { type: 'string' }
          }
        },
        notes: { type: 'string' }
      }
    },
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['usb_c', 'usb_micro', 'antenna_area', 'connector', 'sensor_window', 'button', 'display', 'led', 'fan', 'cable'] },
          label: { type: 'string' },
          side: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
          rect_um: {
            type: 'object',
            required: ['x', 'y', 'w', 'h'],
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
            additionalProperties: false
          },
          notes: { type: 'string' }
        }
      }
    },
    simulation,
    render: { type: 'array', items: renderPrimitive },
    back_render: { type: 'array', items: renderPrimitive },
    evidence,
    geometry_status: status,
    electrical_status: status,
    status_notes: { type: 'string' },
    sources,
    license
  }
} as const;
