import type { JsonValue, PinMeta } from '@breadboard-studio/schema';
import { holeAddress, parseAddress } from './address.js';
import { buildConnectivity, pinKey, resolveAddressKey, voltageName, type Connectivity, type Net } from './connectivity.js';
import { rectsOverlap, segmentIntersectsRect } from './geometry.js';
import { groupHoles, type DesignModel, type PlacedComponent, type PlacedPin } from './model.js';
import type { RuleResult } from './results.js';

type R = RuleResult;

function res(severity: R['severity'], code: string, category: R['category'], message: string, objects: string[], extra: Partial<R> = {}): R {
  return { severity, code, category, message, objects, blocking: false, ...extra };
}

function numOrNull(v: JsonValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface PinRef {
  pc: PlacedComponent;
  pin: PlacedPin;
  key: string;
}

function pinsOfNet(model: DesignModel, net: Net): PinRef[] {
  const out: PinRef[] = [];
  for (const key of net.pins) {
    const parsed = parseAddress(key)!;
    const pc = model.components.get(parsed.owner)!;
    const pin = pc.pins.find((p) => p.name === parsed.name)!;
    out.push({ pc, pin, key });
  }
  return out;
}

function isPower(meta: PinMeta): boolean {
  return meta.role === 'power_in' || meta.role === 'power_out';
}

/** Allowed supply range from instance config, falling back to the definition. */
export function supplyRange(pc: PlacedComponent): { min: number; max: number } | null {
  const cfg = pc.resolved.config.supply_voltage_v;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const min = numOrNull(cfg.min);
    const max = numOrNull(cfg.max);
    if (min !== null && max !== null) return { min, max };
  }
  return pc.def.electrical.supply_voltage_v ?? null;
}

function sourceCapacity(ref: PinRef): number | null {
  const cfg = ref.pc.resolved.config;
  for (const k of ['supply_3v3_max_ma', 'capacity_ma']) {
    const v = numOrNull(cfg[k]);
    if (v !== null) return v;
  }
  return typeof ref.pin.meta.max_source_ma === 'number' ? ref.pin.meta.max_source_ma : null;
}

/** Effective SDA/SCL pin names (config override, then definition). */
export function i2cPins(pc: PlacedComponent): { sda: string; scl: string } | null {
  const i2c = pc.def.electrical.i2c;
  if (!i2c) return null;
  const cfg = pc.resolved.config;
  const sda = typeof cfg.i2c_sda_pin === 'string' ? cfg.i2c_sda_pin : i2c.sda_pin;
  const scl = typeof cfg.i2c_scl_pin === 'string' ? cfg.i2c_scl_pin : i2c.scl_pin;
  if (!pc.pins.some((p) => p.name === sda) || !pc.pins.some((p) => p.name === scl)) return null;
  return { sda, scl };
}

export interface I2cBus {
  /** 0 = the default bus (definition or config.i2c_sda_pin/scl), ≥1 = config.i2c_buses[index-1]. */
  index: number;
  sda: string;
  scl: string;
}

/** Every I²C bus a host exposes: the default pair plus any extra pairs declared in `config.i2c_buses`. */
export function i2cBuses(pc: PlacedComponent): I2cBus[] {
  const first = i2cPins(pc);
  if (!first) return [];
  const buses: I2cBus[] = [{ index: 0, sda: first.sda, scl: first.scl }];
  const extra = pc.resolved.config.i2c_buses;
  if (Array.isArray(extra)) {
    for (const [i, raw] of extra.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const sda = (raw as Record<string, unknown>).sda;
      const scl = (raw as Record<string, unknown>).scl;
      if (typeof sda !== 'string' || typeof scl !== 'string') continue;
      if (!pc.pins.some((p) => p.name === sda) || !pc.pins.some((p) => p.name === scl)) continue;
      buses.push({ index: i + 1, sda, scl });
    }
  }
  return buses;
}

export function busLabel(ctl: PlacedComponent, bus: I2cBus): string {
  return bus.index === 0 ? ctl.instance.id : `${ctl.instance.id} 第 ${bus.index + 1} 条总线（${bus.sda}/${bus.scl}）`;
}

/** Effective I²C address from config (explicit null = unknown) or the catalog default. */
export function i2cAddress(pc: PlacedComponent): number | null {
  const cfg = pc.resolved.config;
  // An explicit null in config means "unknown" and overrides the catalog default.
  if ('i2c_address' in cfg) return numOrNull(cfg.i2c_address);
  return pc.def.electrical.i2c?.address_default ?? null;
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

export interface CheckOutput {
  results: R[];
  connectivity: Connectivity;
}

/** Run every rule on a built model. Model issues (structural) are included. */
export function checkModel(model: DesignModel): CheckOutput {
  const conn = buildConnectivity(model);
  const results: R[] = [...model.issues];
  const comps = [...model.components.values()];

  // ------------------------------------------------------------ placement
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i]!;
      const b = comps[j]!;
      if (!rectsOverlap(a.footprint, b.footprint, 200)) continue;
      const zOverlap = a.zRange[0] < b.zRange[1] && b.zRange[0] < a.zRange[1];
      if (!zOverlap) continue;
      results.push(
        res('error', 'body_collision', 'placement', `元件 ${a.instance.id} 与 ${b.instance.id} 的板体在同一高度层重叠`, [a.instance.id, b.instance.id], {
          blocking: true,
          suggestion: '移动其中一个元件，或改用立式安装。'
        })
      );
    }
  }

  for (const pc of comps) {
    const inserted = pc.pins.filter((p) => p.hole);
    const byRoot = new Map<string, PlacedPin[]>();
    for (const p of inserted) {
      const root = conn.boardOnly.find(pinKey(pc.instance.id, p.name));
      byRoot.set(root, [...(byRoot.get(root) ?? []), p]);
    }
    const internal = pc.def.internal_nets ?? [];
    for (const pins of byRoot.values()) {
      if (pins.length < 2) continue;
      const names = pins.map((p) => p.name);
      const tied = internal.some((g) => names.every((n) => g.includes(n)));
      if (tied) continue;
      const first = pins[0]!.hole!;
      const pb = model.boards.get(first.board_id)!;
      const kind = pb.resolved.holes.get(first.hole)!.kind;
      results.push(
        res('error', 'pins_shorted_by_board', 'placement', `元件 ${pc.instance.id} 的引脚 ${names.join('、')} 插在同一导通组内（${kind === 'rail' ? '电源轨' : '同列五孔'}），被面包板短接`, [pc.instance.id], {
          endpoints: pins.map((p) => holeAddress(p.hole!.board_id, p.hole!.hole)),
          suggestion: '旋转 90° 让引脚跨越不同列，或把元件移离电源轨。'
        })
      );
    }
  }

  // ------------------------------------------------------------ wires
  for (const w of model.wires.values()) {
    if (!w.from || !w.to) continue;
    const endpointOwners = new Set<string>();
    for (const ep of [w.from, w.to]) {
      if (ep.kind === 'terminal') endpointOwners.add(ep.component_id);
      else {
        // Components with a pin in the same hole group own this wire end.
        for (const h of groupHoles(model, ep.address)) {
          const st = model.holes.get(h);
          if (st?.status === 'occupied' && st.component_id) endpointOwners.add(st.component_id);
        }
      }
    }
    const crossed: string[] = [];
    for (const pc of comps) {
      if (endpointOwners.has(pc.instance.id)) continue;
      if (pc.resolved.orientation === 'upright' && pc.resolved.body.height_um > 0) {
        // upright modules are thin; only the strip matters
      }
      for (let i = 1; i < w.points.length; i++) {
        if (segmentIntersectsRect(w.points[i - 1]!, w.points[i]!, pc.footprint)) {
          crossed.push(pc.instance.id);
          break;
        }
      }
    }
    if (crossed.length) {
      if (w.instance.route === 'flat') {
        results.push(
          res('warning', 'wire_crosses_body', 'wire', `硬跳线 ${w.instance.id} 的走线穿过元件 ${crossed.join('、')} 的板体`, [w.instance.id, ...crossed], {
            suggestion: '改为可跨元件的杜邦线（route = elevated）或调整拐点绕开。未做三维碰撞分析。'
          })
        );
      } else {
        results.push(res('info', 'wire_over_body', 'wire', `杜邦线 ${w.instance.id} 跨越元件 ${crossed.join('、')} 上方（示意，未做三维碰撞分析）`, [w.instance.id, ...crossed]));
      }
    }
  }
  for (const c of model.design.constraints) {
    if (c.type !== 'wire_length_max_um') continue;
    for (const w of model.wires.values()) {
      if (c.wire_ids && !c.wire_ids.includes(w.instance.id)) continue;
      if (w.length_um > c.max_um) {
        results.push(
          res('warning', 'wire_too_long', 'wire', `导线 ${w.instance.id} 估算长度 ${(w.length_um / 1000).toFixed(1)} mm 超过约束 ${c.id} 的 ${(c.max_um / 1000).toFixed(1)} mm`, [w.instance.id, c.id], {
            suggestion: '估算长度不含插入深度和弯折余量。'
          })
        );
      }
    }
  }

  // ------------------------------------------------------------ net intents
  const netsByIntent = new Map<string, Net[]>();
  for (const intent of model.design.net_intents) {
    const roots = new Map<string, string[]>();
    for (const ep of intent.endpoints) {
      const key = resolveAddressKey(model, ep);
      if (!key) {
        results.push(res('error', 'unknown_reference', 'schema', `网络意图 ${intent.id}（${intent.name}）引用了不存在的端点 ${ep}`, [intent.id], { endpoints: [ep], blocking: true }));
        continue;
      }
      const r = conn.full.find(key);
      roots.set(r, [...(roots.get(r) ?? []), ep]);
    }
    const groups = [...roots.values()];
    if (groups.length > 1) {
      results.push(
        res('warning', 'net_intent_open', 'net', `网络 ${intent.name}（${intent.id}）尚未完全连通：${groups.map((g) => `[${g.join(', ')}]`).join(' 与 ')}`, [intent.id], {
          endpoints: intent.endpoints,
          suggestion: '在这些端点所在的孔组之间添加导线。声明意图不会自动生成导线。'
        })
      );
    }
    for (const r of roots.keys()) {
      const net = conn.netByRoot.get(r);
      if (net) netsByIntent.set(intent.id, [...(netsByIntent.get(intent.id) ?? []), net]);
    }
  }
  for (const net of conn.nets) {
    if (net.intent_ids.length > 1) {
      results.push(
        res('warning', 'net_intent_merged', 'net', `网络意图 ${net.intent_ids.join(' 与 ')} 实际被连在了同一个网络里`, net.intent_ids, {
          endpoints: net.pins,
          suggestion: '检查是否有导线或同列五孔把两个网络短接了。'
        })
      );
    }
  }

  // ------------------------------------------------------------ electrical per net
  const connectedComponents = new Set<string>();
  for (const net of conn.nets) {
    const owners = new Set(net.pins.map((k) => parseAddress(k)!.owner));
    if (owners.size >= 2) for (const o of owners) connectedComponents.add(o);
  }

  for (const net of conn.nets) {
    const pins = pinsOfNet(model, net);
    const grounds = pins.filter((p) => p.pin.meta.role === 'ground');
    const powers = pins.filter((p) => isPower(p.pin.meta));
    if (grounds.length && powers.length) {
      results.push(
        res('error', 'power_ground_short', 'net', `电源与地被直接短接：${powers.map((p) => p.key).join('、')} 与 ${grounds.map((p) => p.key).join('、')} 在同一网络`, [...new Set([...powers, ...grounds].map((p) => p.pc.instance.id))], {
          endpoints: [...powers, ...grounds].map((p) => p.key),
          suggestion: '检查导线端点和同列五孔占用。'
        })
      );
    }
    const voltages = new Map<number, string[]>();
    for (const p of powers) {
      const v = p.pin.meta.voltage_v;
      if (typeof v === 'number') voltages.set(v, [...(voltages.get(v) ?? []), p.key]);
    }
    if (voltages.size > 1) {
      const desc = [...voltages.entries()].map(([v, keys]) => `${voltageName(v)}（${keys.join(', ')}）`).join(' 与 ');
      results.push(
        res('error', 'voltage_conflict', 'net', `不同电压的电源端在同一网络：${desc}`, [...new Set(powers.map((p) => p.pc.instance.id))], {
          endpoints: powers.map((p) => p.key),
          suggestion: '不同电压源不能直接并联；检查供电导线。'
        })
      );
    }
    // Supply range check for power_in pins fed by a known power_out voltage.
    const sources = powers.filter((p) => p.pin.meta.role === 'power_out' && typeof p.pin.meta.voltage_v === 'number');
    const sinks = powers.filter((p) => p.pin.meta.role === 'power_in');
    if (sources.length && voltages.size === 1) {
      const v = sources[0]!.pin.meta.voltage_v as number;
      for (const s of sinks) {
        const range = supplyRange(s.pc);
        if (!range) {
          results.push(
            res('needs_review', 'supply_range_unknown', 'evidence', `${s.key} 接到 ${voltageName(v)} 供电，但该模块允许的供电范围未知`, [s.pc.instance.id], {
              endpoints: [s.key],
              suggestion: '查阅转接板资料后在 config.supply_voltage_v 填写范围。'
            })
          );
        } else if (v < range.min || v > range.max) {
          results.push(
            res('error', 'supply_out_of_range', 'net', `${s.key} 允许 ${range.min}–${range.max} V，却接到 ${voltageName(v)}`, [s.pc.instance.id], {
              endpoints: [s.key, ...sources.map((x) => x.key)]
            })
          );
        }
      }
    }
    // Output conflicts: only pins explicitly declared as push-pull outputs count.
    const outs = pins.filter((p) => p.pin.meta.direction === 'out' && p.pin.meta.drive === 'push_pull');
    if (outs.length >= 2) {
      results.push(
        res('error', 'output_conflict', 'interface', `多个推挽输出接在同一网络：${outs.map((p) => p.key).join('、')}`, [...new Set(outs.map((p) => p.pc.instance.id))], {
          endpoints: outs.map((p) => p.key),
          suggestion: '推挽输出不能并联；开漏输出可以共线。'
        })
      );
    }
    // Logic level between signal pins.
    const signals = pins.filter((p) => ['gpio', 'analog', 'i2c_sda', 'i2c_scl', 'signal_in', 'signal_out'].includes(p.pin.meta.role));
    if (signals.length >= 2) {
      const levels = new Map<number, string[]>();
      const unknown: string[] = [];
      for (const p of signals) {
        const lv = p.pin.meta.io_voltage_v;
        if (typeof lv === 'number') levels.set(lv, [...(levels.get(lv) ?? []), p.key]);
        else {
          const supply = numOrNull(p.pc.resolved.config.supply_v);
          if (supply !== null) levels.set(supply, [...(levels.get(supply) ?? []), p.key]);
          else unknown.push(p.key);
        }
      }
      if (levels.size > 1) {
        results.push(
          res('warning', 'level_mismatch', 'interface', `信号电平不一致：${[...levels.entries()].map(([v, k]) => `${voltageName(v)}（${k.join(', ')}）`).join(' 与 ')}`, [...new Set(signals.map((p) => p.pc.instance.id))], {
            endpoints: signals.map((p) => p.key),
            suggestion: '确认两侧电平兼容，必要时加电平转换。'
          })
        );
      }
      if (unknown.length && levels.size) {
        results.push(
          res('needs_review', 'io_level_unknown', 'evidence', `${unknown.join('、')} 的信号电平未知（取决于模块供电），无法判断与 ${[...levels.values()].flat().join('、')} 是否兼容`, [...new Set(signals.map((p) => p.pc.instance.id))], {
            endpoints: signals.map((p) => p.key),
            suggestion: '在模块 config 中填写实际供电电压（supply_v）。'
          })
        );
      }
    }
    // Power budget per supply net.
    if (sources.length && !grounds.length) {
      const consumers = [...new Set(sinks.map((s) => s.pc))];
      if (consumers.length) {
        let capacity: number | null = null;
        for (const s of sources) {
          const c = sourceCapacity(s);
          if (c !== null) capacity = capacity === null ? c : Math.max(capacity, c);
        }
        let typical = 0;
        let peak = 0;
        const unknownTypical: string[] = [];
        const unknownPeak: string[] = [];
        for (const c of consumers) {
          const cur = c.def.electrical.supply_current_ma;
          if (cur && typeof cur.typical === 'number') typical += cur.typical;
          else unknownTypical.push(c.instance.id);
          if (cur && typeof cur.peak === 'number') peak += cur.peak;
          else if (cur && typeof cur.typical === 'number') {
            peak += cur.typical;
            unknownPeak.push(c.instance.id);
          } else unknownPeak.push(c.instance.id);
        }
        const srcDesc = sources.map((s) => s.key).join('、');
        const objs = [...new Set([...sources.map((s) => s.pc.instance.id), ...consumers.map((c) => c.instance.id)])];
        const budget = `典型合计 ≥ ${typical.toFixed(1)} mA${unknownTypical.length ? `（${unknownTypical.join('、')} 典型电流未知）` : ''}，峰值${unknownPeak.length ? `未知（${unknownPeak.join('、')}）` : ` ≥ ${peak.toFixed(1)} mA`}`;
        if (capacity === null) {
          results.push(
            res('needs_review', 'power_capacity_unknown', 'evidence', `供电 ${srcDesc} 的输出能力未知；负载 ${budget}`, objs, {
              endpoints: sources.map((s) => s.key),
              suggestion: '在电源/主控 config 中填写实测或资料给出的输出能力（如 capacity_ma、supply_3v3_max_ma）。'
            })
          );
        } else if (typical > capacity) {
          results.push(res('error', 'power_budget_exceeded', 'net', `供电 ${srcDesc} 能力 ${capacity} mA 低于负载典型电流合计 ${typical.toFixed(1)} mA`, objs, { endpoints: sources.map((s) => s.key) }));
        } else if (unknownPeak.length || unknownTypical.length) {
          results.push(
            res('needs_review', 'power_peak_unknown', 'evidence', `供电 ${srcDesc} 能力 ${capacity} mA；${budget}。峰值/未知项未核实，不能据此判定供电足够`, objs, {
              endpoints: sources.map((s) => s.key),
              suggestion: '查数据手册中的启动/峰值电流，并留出余量。'
            })
          );
        } else if (peak > capacity) {
          results.push(res('warning', 'power_peak_exceeded', 'net', `供电 ${srcDesc} 能力 ${capacity} mA 低于负载峰值合计 ${peak.toFixed(1)} mA`, objs, { endpoints: sources.map((s) => s.key) }));
        } else {
          results.push(res('info', 'power_budget_within_datasheet', 'net', `供电 ${srcDesc} 能力 ${capacity} mA，负载 ${budget}。这是资料数值比较，不是实测结果`, objs, { endpoints: sources.map((s) => s.key) }));
        }
      }
    }
  }

  // ------------------------------------------------------------ per component power / ground
  const groundNets = new Map<string, Set<string>>(); // component -> roots of its ground pins
  for (const pc of comps) {
    if (!connectedComponents.has(pc.instance.id)) continue;
    for (const p of pc.pins) {
      if (p.meta.role === 'ground') {
        const root = conn.full.find(pinKey(pc.instance.id, p.name));
        groundNets.set(pc.instance.id, new Set([...(groundNets.get(pc.instance.id) ?? []), root]));
      }
    }
    const powerIns = pc.pins.filter((p) => p.meta.role === 'power_in');
    const isSource = pc.pins.some((p) => p.meta.role === 'power_out');
    if (powerIns.length && !isSource) {
      const fed = powerIns.some((p) => {
        const net = conn.netByRoot.get(conn.full.find(pinKey(pc.instance.id, p.name)));
        return net ? pinsOfNet(model, net).some((x) => x.pin.meta.role === 'power_out') : false;
      });
      if (!fed) {
        results.push(
          res('warning', 'power_in_unconnected', 'net', `元件 ${pc.instance.id} 已接信号线，但供电引脚（${powerIns.map((p) => p.name).join('、')}）没有接到任何电源输出`, [pc.instance.id], {
            endpoints: powerIns.map((p) => pinKey(pc.instance.id, p.name))
          })
        );
      }
    }
  }
  if (groundNets.size >= 2) {
    const allRoots = new Set<string>();
    for (const s of groundNets.values()) for (const r of s) allRoots.add(r);
    if (allRoots.size > 1) {
      results.push(
        res('warning', 'no_common_ground', 'net', `已连接的元件没有共享同一个地：${[...groundNets.keys()].join('、')} 的 GND 分属 ${allRoots.size} 个网络`, [...groundNets.keys()], {
          suggestion: '用导线把所有 GND 接到同一电源轨或同一网络。'
        })
      );
    }
  }

  // ------------------------------------------------------------ isolate constraints
  for (const c of model.design.constraints) {
    if (c.type !== 'isolate') continue;
    const ka = resolveAddressKey(model, c.a);
    const kb = resolveAddressKey(model, c.b);
    if (!ka || !kb) {
      results.push(res('error', 'unknown_reference', 'schema', `约束 ${c.id} 引用了不存在的端点 ${!ka ? c.a : c.b}`, [c.id], { blocking: true }));
      continue;
    }
    if (conn.full.connected(ka, kb)) {
      results.push(res('error', 'isolation_violated', 'net', `约束 ${c.id} 要求 ${c.a} 与 ${c.b} 隔离，但它们已导通`, [c.id], { endpoints: [c.a, c.b] }));
    }
  }

  // ------------------------------------------------------------ I2C buses
  const controllers = comps.filter((pc) => pc.def.category === 'mcu' && i2cPins(pc));
  const devices = comps.filter((pc) => pc.def.category !== 'mcu' && i2cPins(pc));
  const buses: { controller: PlacedComponent; bus: I2cBus; label: string; sdaRoot: string; sclRoot: string; devices: PlacedComponent[] }[] = [];
  for (const ctl of controllers) {
    const declared = i2cBuses(ctl);
    const rawExtra = ctl.resolved.config.i2c_buses;
    if (Array.isArray(rawExtra) && rawExtra.length !== declared.length - 1) {
      results.push(res('warning', 'i2c_bus_config_invalid', 'interface', `${ctl.instance.id} 的 config.i2c_buses 中有条目引用了不存在的引脚，已忽略`, [ctl.instance.id], { suggestion: '每条总线需要 {sda, scl} 两个存在的针名。' }));
    }
    const maxBuses = ctl.def.electrical.i2c?.controllers;
    if (typeof maxBuses === 'number' && declared.length > maxBuses) {
      results.push(res('warning', 'i2c_bus_count_exceeded', 'interface', `${ctl.instance.id} 声明了 ${declared.length} 条 I²C 总线，但目录记录它只有 ${maxBuses} 个 I²C 控制器`, [ctl.instance.id], { suggestion: '删除多余的 config.i2c_buses 条目，或改用软件 I²C 并自行核实。' }));
    }
    const seenPins = new Set<string>();
    for (const bus of declared) {
      const label = busLabel(ctl, bus);
      for (const pin of [bus.sda, bus.scl]) {
        if (seenPins.has(pin)) results.push(res('error', 'i2c_bus_pin_reused', 'interface', `${ctl.instance.id} 的引脚 ${pin} 被多条 I²C 总线使用`, [ctl.instance.id], { endpoints: [pinKey(ctl.instance.id, pin)] }));
        seenPins.add(pin);
      }
      const sdaRoot = conn.full.find(pinKey(ctl.instance.id, bus.sda));
      const sclRoot = conn.full.find(pinKey(ctl.instance.id, bus.scl));
      if (sdaRoot === sclRoot) {
        results.push(res('error', 'i2c_sda_scl_shorted', 'interface', `${label} 的 SDA 与 SCL 在同一网络`, [ctl.instance.id], { endpoints: [pinKey(ctl.instance.id, bus.sda), pinKey(ctl.instance.id, bus.scl)] }));
      }
      buses.push({ controller: ctl, bus, label, sdaRoot, sclRoot, devices: [] });
    }
  }
  for (const dev of devices) {
    const p = i2cPins(dev)!;
    const sdaRoot = conn.full.find(pinKey(dev.instance.id, p.sda));
    const sclRoot = conn.full.find(pinKey(dev.instance.id, p.scl));
    const sdaNet = conn.netByRoot.get(sdaRoot);
    const sclNet = conn.netByRoot.get(sclRoot);
    const wired = (sdaNet && sdaNet.pins.length > 1) || (sclNet && sclNet.pins.length > 1);
    if (!wired) continue;
    let matched = false;
    for (const bus of buses) {
      const sdaOk = bus.sdaRoot === sdaRoot;
      const sclOk = bus.sclRoot === sclRoot;
      if (sdaOk && sclOk) {
        bus.devices.push(dev);
        matched = true;
      } else if (sdaOk || sclOk || bus.sdaRoot === sclRoot || bus.sclRoot === sdaRoot) {
        results.push(
          res('warning', 'i2c_bus_mismatch', 'interface', `${dev.instance.id} 的 SDA/SCL 只有一根接到 ${bus.label} 的总线，或 SDA/SCL 接反`, [dev.instance.id, bus.controller.instance.id], {
            endpoints: [pinKey(dev.instance.id, p.sda), pinKey(dev.instance.id, p.scl)]
          })
        );
        matched = true;
      }
    }
    if (!matched) {
      results.push(res('info', 'i2c_device_without_controller', 'interface', `${dev.instance.id} 的 I²C 引脚已接线，但没有接到任何主控的 I²C 总线`, [dev.instance.id]));
    }
  }
  for (const bus of buses) {
    const byAddr = new Map<number, PlacedComponent[]>();
    for (const dev of bus.devices) {
      const addr = i2cAddress(dev);
      if (addr === null) {
        results.push(
          res('needs_review', 'i2c_address_unknown', 'evidence', `${dev.instance.id} 在 ${bus.label} 的 I²C 总线上，但地址未知，无法检查冲突`, [dev.instance.id], {
            suggestion: '在 config.i2c_address 填写实际地址。'
          })
        );
        continue;
      }
      byAddr.set(addr, [...(byAddr.get(addr) ?? []), dev]);
    }
    for (const [addr, devs] of byAddr) {
      if (devs.length > 1) {
        results.push(
          res('error', 'i2c_address_conflict', 'interface', `同一 I²C 总线（${bus.label}）上有多个器件使用地址 ${hex(addr)}：${devs.map((d) => d.instance.id).join('、')}`, devs.map((d) => d.instance.id), {
            suggestion: '修改可配置地址（config.i2c_address）、换用第二条总线或加 I²C 多路复用器。'
          })
        );
      }
    }
  }

  // ------------------------------------------------------------ evidence
  for (const pb of model.boards.values()) {
    if (pb.def.geometry_status !== 'verified' || pb.def.electrical_status !== 'verified') {
      results.push(
        res('needs_review', 'model_unverified', 'evidence', `面包板 ${pb.instance.id}（${pb.def.name}）几何=${pb.def.geometry_status}，电气=${pb.def.electrical_status}：${pb.def.status_notes ?? '未经实测'}`, [pb.instance.id])
      );
    }
  }
  for (const pc of comps) {
    if (pc.def.geometry_status !== 'verified' || pc.def.electrical_status !== 'verified') {
      results.push(
        res('needs_review', 'model_unverified', 'evidence', `元件 ${pc.instance.id}（${pc.def.name}）几何=${pc.def.geometry_status}，电气=${pc.def.electrical_status}：${pc.def.status_notes ?? '未经实测'}`, [pc.instance.id])
      );
    }
  }

  return { results, connectivity: conn };
}
