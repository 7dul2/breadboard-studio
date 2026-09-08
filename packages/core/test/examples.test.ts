import { describe, it, expect } from 'vitest';
import { activeProgram, analyzeDesign, designHash, loadDesign, programsForComponent, serializeDesign } from '../src/index.js';
import { loadExample } from './helpers.js';

describe('touch_display example (fixed simulator reference design)', () => {
  const design = loadExample('touch_display.breadboard.json');

  it('is a schema 1.1 document with one Studio TS program on the MCU', () => {
    expect(design.schema_version).toBe('1.1');
    expect(design.programs).toHaveLength(1);
    const program = design.programs![0]!;
    expect(program.id).toBe('program_main');
    expect(program.target_component_id).toBe('mcu');
    expect(program.language).toBe('studio-ts');
    expect(program.source).toContain('Wire.begin');
    expect(design.simulation?.active_program_id).toBe('program_main');
    expect(activeProgram(design)?.id).toBe('program_main');
    expect(programsForComponent(design, 'mcu')).toHaveLength(1);
  });

  it('analyzes without errors and survives a serialize → load round trip', () => {
    const analysis = analyzeDesign(design);
    expect(analysis.summary.error).toBe(0);
    expect(analysis.summary.blocking).toBe(0);
    const back = loadDesign(serializeDesign(design));
    expect(back.ok).toBe(true);
    expect(back.design).toEqual(design);
    expect(designHash(back.design!)).toBe(designHash(design));
  });

  it('connects the touch output and the I²C bus to the pins the program uses', () => {
    const nets = analyzeDesign(design).connectivity.nets;
    const netWith = (...pins: string[]) => nets.find((net) => pins.every((pin) => net.pins.includes(pin)));
    expect(netWith('touch.IO', 'mcu.GPIO4'), 'touch IO → GPIO4').toBeDefined();
    expect(netWith('oled.SDA', 'mcu.GPIO8'), 'SDA → GPIO8').toBeDefined();
    expect(netWith('oled.SCL', 'mcu.GPIO9'), 'SCL → GPIO9').toBeDefined();
  });
});
