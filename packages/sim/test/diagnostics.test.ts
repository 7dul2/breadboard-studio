import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SIM_DIAGNOSTIC_CODES, SIM_DIAGNOSTIC_SEVERITY, isSimDiagnosticCode, type SimDiagnosticCode } from '../src/index.js';

const srcDir = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('diagnostic code registry', () => {
  it('is a duplicate-free list whose severity map covers exactly the same codes', () => {
    expect(new Set(SIM_DIAGNOSTIC_CODES).size).toBe(SIM_DIAGNOSTIC_CODES.length);
    expect(Object.keys(SIM_DIAGNOSTIC_SEVERITY).sort()).toEqual([...SIM_DIAGNOSTIC_CODES].sort());
    for (const code of SIM_DIAGNOSTIC_CODES) {
      expect(['error', 'warning', 'info'], code).toContain(SIM_DIAGNOSTIC_SEVERITY[code]);
    }
    expect(isSimDiagnosticCode('i2c_nack')).toBe(true);
    expect(isSimDiagnosticCode('not_a_real_code')).toBe(false);
  });

  it('keeps every code the session must survive out of the error tier', () => {
    // The controller faults the session on any error diagnostic, so a NACK, a
    // floating pin or an unpowered device must never be one.
    for (const code of ['device_unpowered', 'missing_common_ground', 'digital_contention', 'floating_input', 'reserved_pin_used', 'i2c_nack', 'i2c_address_collision', 'i2c_bus_unavailable', 'i2c_unknown_command'] as const) {
      expect(SIM_DIAGNOSTIC_SEVERITY[code], code).toBe('warning');
    }
    for (const code of ['unsupported_device', 'supply_range_unknown', 'waiting_for_input', 'stale_simulation_snapshot'] as const) {
      expect(SIM_DIAGNOSTIC_SEVERITY[code], code).toBe('info');
    }
    for (const code of ['execution_budget_exceeded', 'event_queue_overflow', 'simulation_deadlock', 'program_compile_error', 'program_runtime_error'] as const) {
      expect(SIM_DIAGNOSTIC_SEVERITY[code], code).toBe('error');
    }
  });

  it('every diagnostic emitted in the source is registered with the mapped severity', () => {
    // Scans literal `code: '…', severity: '…'` pairs so a new driver cannot
    // invent a code or downgrade one without updating the registry.
    const emitted: { file: string; code: string; severity: string }[] = [];
    for (const file of tsFiles(srcDir)) {
      if (file.endsWith('types.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/code:\s*'([a-z0-9_]+)'\s*,\s*severity:\s*'(error|warning|info)'/g)) {
        emitted.push({ file, code: m[1]!, severity: m[2]! });
      }
    }
    expect(emitted.length).toBeGreaterThan(0);
    for (const e of emitted) {
      expect(isSimDiagnosticCode(e.code), `${e.file}: ${e.code}`).toBe(true);
      expect(SIM_DIAGNOSTIC_SEVERITY[e.code as SimDiagnosticCode], `${e.file}: ${e.code}`).toBe(e.severity);
    }
  });
});
