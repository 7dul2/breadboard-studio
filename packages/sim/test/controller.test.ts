import { describe, it, expect } from 'vitest';
import type { ProgramAsset } from '@breadboard-studio/schema';
import { applyOps, createEmptyDesign, type Op, type SimulationConfigPatch } from '@breadboard-studio/core';
import { SIM_PROTOCOL_VERSION, SimulatorController, SimBackendError, UnavailableBackend, buildSnapshot, createProgramAsset, netIdFor, type RuntimeMessage, type SimulationBackend, type SimulationSnapshot } from '../src/index.js';

function build(ops: Op[]) {
  const r = applyOps(createEmptyDesign('sim'), ops);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.design;
}

const wired: Op[] = [
  { op: 'add_board', board: { id: 'bb', model: 'breadboard_830@1', position_um: [0, 0], rotation_deg: 0 } },
  { op: 'add_component', component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b30', anchor_pin: 'GND_3', rotation_deg: 90 } } },
  { op: 'add_component', component: { id: 'touch', model: 'ttp223_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j10', anchor_pin: 'VCC', rotation_deg: 0 } } },
  { op: 'add_wire', wire: { id: 'w_gnd', from: { pin: 'mcu.GND_3' }, to: { pin: 'touch.GND' }, color: 'black' } },
  { op: 'add_program', program: createProgramAsset({ id: 'program_main', target_component_id: 'mcu', name: '主程序' }) },
  { op: 'set_simulation_config', patch: { active_program_id: 'program_main', usb_powered_components: ['mcu'] } }
];

class FakeBackend implements SimulationBackend {
  readonly id = 'fake@1';
  calls: string[] = [];
  snapshot: SimulationSnapshot | null = null;
  program: ProgramAsset | null = null;
  private listeners: ((m: RuntimeMessage) => void)[] = [];
  constructor(private readonly failPrepare = false) {}
  prepare(snapshot: SimulationSnapshot, program: ProgramAsset): Promise<void> {
    this.calls.push('prepare');
    this.snapshot = snapshot;
    this.program = program;
    if (this.failPrepare) return Promise.reject(new SimBackendError({ code: 'program_compile_error', severity: 'error', message: 'boom', source: { programId: program.id, line: 3, column: 1 } }));
    return Promise.resolve();
  }
  start() {
    this.calls.push('start');
    return Promise.resolve();
  }
  pause() {
    this.calls.push('pause');
    return Promise.resolve();
  }
  step() {
    this.calls.push('step');
    return Promise.resolve();
  }
  reset() {
    this.calls.push('reset');
    return Promise.resolve();
  }
  sendControl() {
    this.calls.push('control');
  }
  onMessage(listener: (m: RuntimeMessage) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  dispose() {
    this.calls.push('dispose');
    return Promise.resolve();
  }
  emit(message: RuntimeMessage) {
    for (const l of this.listeners) l(message);
  }
}

describe('snapshot', () => {
  it('is stable for the same design and changes with the topology', () => {
    const d = build(wired);
    const a = buildSnapshot(d);
    const b = buildSnapshot(d);
    expect(a).toEqual(b);
    expect(a.protocol).toBe(SIM_PROTOCOL_VERSION);
    expect(a.programs.map((p) => p.id)).toEqual(['program_main']);
    expect(a.config).toEqual({ active_program_id: 'program_main', usb_powered_components: ['mcu'] });
    const gnd = a.nets.find((n) => n.members.includes('mcu.GND_3'))!;
    expect(gnd.members).toContain('touch.GND');
    expect(gnd.id).toBe(netIdFor(gnd.members));
    expect(a.pinToNet['touch.GND']).toBe(gnd.id);
    const mcu = a.devices.find((x) => x.componentId === 'mcu')!;
    expect(mcu.pinNets.GND_3).toBe(gnd.id);
    expect(mcu.driver).toBe('mcu.esp32s3.behavioral@1');
    expect(mcu.pinChannels.GPIO48).toBe(48);
    const touch = a.devices.find((x) => x.componentId === 'touch')!;
    expect(touch.driver).toBe('input.ttp223@1');
    expect(touch.properties.output_mode).toBe('active_high');
    const moved = applyOps(d, [{ op: 'remove_wire', id: 'w_gnd' }]);
    if (!moved.ok) throw new Error('remove failed');
    const c = buildSnapshot(moved.design);
    expect(c.designHash).not.toBe(a.designHash);
    expect(c.pinToNet['touch.GND']).not.toBe(a.pinToNet['touch.GND']);
    expect(c.nets.some((n) => n.id === gnd.id)).toBe(false);
  });
});

describe('simulator controller', () => {
  it('refuses to start without a program or with a structurally broken design, staying idle', async () => {
    const ctl = new SimulatorController({ backend: () => new FakeBackend() });
    const noProgram = build(wired.slice(0, 4));
    const r = await ctl.run(noProgram);
    expect(r.ok).toBe(false);
    expect(ctl.getState().status).toBe('idle');
    expect(ctl.getState().diagnostics[0]?.code).toBe('program_missing');
    const broken = build(wired);
    broken.programs![0]!.target_component_id = 'ghost';
    const r2 = await ctl.run(broken);
    expect(r2.ok).toBe(false);
    expect(ctl.getState().status).toBe('idle');
    expect(ctl.getState().diagnostics[0]?.code).toBe('simulation_blocked_by_design');
    expect(ctl.getState().diagnostics[0]?.message).toContain('program_target_missing');
  });

  it('faults with runtime_unavailable when no backend exists, and stop/reset behave', async () => {
    const seen: string[] = [];
    const ctl = new SimulatorController();
    ctl.subscribe((s) => seen.push(s.status));
    const d = build(wired);
    const r = await ctl.run(d);
    expect(r.ok).toBe(true);
    const s = ctl.getState();
    expect(s.status).toBe('faulted');
    expect(s.sessionId).toBe('sim-1');
    expect(s.programId).toBe('program_main');
    expect(s.diagnostics.map((x) => x.code)).toEqual(['runtime_unavailable']);
    expect(s.allowed).toEqual(['reset', 'stop']);
    expect(s.canEditTopology).toBe(true);
    expect(seen).toEqual(['compiling', 'compiling', 'faulted']);
    expect((await ctl.pause()).ok).toBe(false);
    const reset = await ctl.reset();
    expect(reset.ok).toBe(true);
    expect(ctl.getState().sessionId).toBe('sim-2');
    expect(ctl.getState().status).toBe('faulted');
    expect((await ctl.stop()).ok).toBe(true);
    expect(ctl.getState().status).toBe('idle');
    expect(ctl.getState().sessionId).toBeNull();
    expect(ctl.getState().diagnostics.length).toBe(1);
    ctl.clearDiagnostics();
    expect(ctl.getState().diagnostics).toEqual([]);
    expect(ctl.getState().status).toBe('idle');
    const unavailable = new UnavailableBackend();
    await expect(unavailable.prepare(buildSnapshot(d), d.programs![0]!)).rejects.toBeInstanceOf(SimBackendError);
  });

  it('drives a backend through run/pause/step/reset/stop and filters foreign messages', async () => {
    let backend: FakeBackend | null = null;
    const ctl = new SimulatorController({ backend: () => (backend = new FakeBackend()), serialLimit: 2 });
    const d = build(wired);
    await ctl.run(d);
    expect(ctl.getState().status).toBe('running');
    expect(backend!.calls).toEqual(['prepare', 'start']);
    expect(backend!.snapshot?.designHash).toBe(ctl.getState().designHash);
    expect(backend!.program?.id).toBe('program_main');
    const session = ctl.getState().sessionId!;
    backend!.emit({ protocol: SIM_PROTOCOL_VERSION, sessionId: session, type: 'status', status: 'running', nowUs: 1500 });
    backend!.emit({ protocol: SIM_PROTOCOL_VERSION, sessionId: 'sim-0', type: 'status', status: 'running', nowUs: 99 });
    backend!.emit({ protocol: 2 as never, sessionId: session, type: 'status', status: 'running', nowUs: 99 });
    expect(ctl.getState().nowUs).toBe(1500);
    expect(ctl.getState().droppedMessages).toBe(2);
    for (const i of [1, 2, 3]) backend!.emit({ protocol: SIM_PROTOCOL_VERSION, sessionId: session, type: 'serial', componentId: 'mcu', stream: 'stdout', text: `line ${i}`, atUs: i });
    expect(ctl.getState().serial.map((l) => l.text)).toEqual(['line 2', 'line 3']);
    backend!.emit({ protocol: SIM_PROTOCOL_VERSION, sessionId: session, type: 'diagnostic', diagnostic: { code: 'floating_input', severity: 'warning', message: 'w', atUs: 2 } });
    expect(ctl.getState().status).toBe('running');
    expect(ctl.sendControl({ componentId: 'touch', controlId: 'touch', action: 'touch', value: true })).toBe(true);
    expect((await ctl.pause()).ok).toBe(true);
    expect(ctl.getState().status).toBe('paused');
    expect((await ctl.step()).ok).toBe(true);
    expect(ctl.getState().status).toBe('paused');
    expect((await ctl.reset()).ok).toBe(true);
    expect(ctl.getState().status).toBe('paused');
    expect(ctl.getState().nowUs).toBe(0);
    expect(ctl.getState().serial).toEqual([]);
    expect(ctl.getState().diagnostics).toEqual([]);
    expect((await ctl.run(d)).ok).toBe(true);
    expect(ctl.getState().status).toBe('running');
    expect(backend!.calls).toEqual(['prepare', 'start', 'control', 'pause', 'step', 'reset', 'start']);
    backend!.emit({ protocol: SIM_PROTOCOL_VERSION, sessionId: session, type: 'diagnostic', diagnostic: { code: 'program_runtime_error', severity: 'error', message: 'crash', atUs: 5 } });
    expect(ctl.getState().status).toBe('faulted');
    expect(backend!.calls.at(-1)).toBe('dispose');
    expect(ctl.sendControl({ componentId: 'touch', controlId: 'touch', action: 'touch', value: false })).toBe(false);
    expect((await ctl.stop()).ok).toBe(true);
    expect(ctl.getState().status).toBe('idle');
  });

  it('reports compile failures from the backend at the source location', async () => {
    const ctl = new SimulatorController({ backend: () => new FakeBackend(true) });
    await ctl.run(build(wired));
    const s = ctl.getState();
    expect(s.status).toBe('faulted');
    expect(s.diagnostics[0]).toMatchObject({ code: 'program_compile_error', source: { programId: 'program_main', line: 3 } });
  });

  it('stops a session when the design changes underneath it', async () => {
    let backend: FakeBackend | null = null;
    const ctl = new SimulatorController({ backend: () => (backend = new FakeBackend()) });
    const d = build(wired);
    await ctl.run(d);
    expect(ctl.designChanged(d)).toBe(false);
    expect(ctl.getState().status).toBe('running');
    const viewOnly = { ...d, view: { zoom: 3 } };
    expect(ctl.designChanged(viewOnly)).toBe(false);
    const edited = applyOps(d, [{ op: 'update_program', id: 'program_main', patch: { source: '// changed' } }]);
    if (!edited.ok) throw new Error('edit failed');
    expect(ctl.designChanged(edited.design)).toBe(true);
    const s = ctl.getState();
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBeNull();
    expect(s.diagnostics.map((x) => x.code)).toEqual(['stale_simulation_snapshot']);
    expect(backend!.calls).toContain('dispose');
    expect(ctl.designChanged(edited.design)).toBe(false);
  });
});

describe('simulator controller · session lifetime edge cases', () => {
  it('keeps playback speed out of stale detection but invalidates on seed, USB power and program changes', async () => {
    const ctl = new SimulatorController({ backend: () => new FakeBackend() });
    const d = build(wired);
    await ctl.run(d);
    expect(ctl.getState().status).toBe('running');
    // speed is seeded from the document and is a live control: changing it must not kill the session
    expect(ctl.getState().speed).toBe(1);
    const faster = applyOps(d, [{ op: 'set_simulation_config', patch: { speed: 2 } }]);
    if (!faster.ok) throw new Error('speed change failed');
    const hashBefore = ctl.getState().designHash;
    expect(ctl.designChanged(faster.design)).toBe(false);
    expect(ctl.getState().status).toBe('running');
    // the session survives, and the reported hash/speed follow the current document
    expect(ctl.getState().designHash).not.toBe(hashBefore);
    expect(ctl.getState().speed).toBe(2);
    const patches: SimulationConfigPatch[] = [{ random_seed: 9 }, { usb_powered_components: [] }, { active_program_id: null }];
    for (const patch of patches) {
      const changed = applyOps(faster.design, [{ op: 'set_simulation_config', patch }]);
      if (!changed.ok) throw new Error('config change failed');
      const probe = new SimulatorController({ backend: () => new FakeBackend() });
      await probe.run(faster.design);
      expect(probe.designChanged(changed.design), JSON.stringify(patch)).toBe(true);
      expect(probe.getState().status).toBe('idle');
    }
  });

  it('seeds the speed from the launched document', async () => {
    const ctl = new SimulatorController({ backend: () => new FakeBackend() });
    const d = applyOps(build(wired), [{ op: 'set_simulation_config', patch: { speed: 5 } }]);
    if (!d.ok) throw new Error('setup failed');
    await ctl.run(d.design);
    expect(ctl.getState().speed).toBe(5);
  });

  it('a session started while the previous backend is still disposing keeps its own identity', async () => {
    class SlowDispose extends FakeBackend {
      override dispose(): Promise<void> {
        this.calls.push('dispose');
        return new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const ctl = new SimulatorController({ backend: () => new SlowDispose() });
    const d = build(wired);
    await ctl.run(d);
    const first = ctl.getState().sessionId;
    const stopping = ctl.stop();
    expect(ctl.getState().sessionId).toBeNull();
    await ctl.run(d);
    const second = ctl.getState().sessionId;
    expect(second).not.toBe(first);
    await stopping;
    const s = ctl.getState();
    expect(s.status).toBe('running');
    expect(s.sessionId).toBe(second);
    expect(s.designHash).not.toBeNull();
    expect(s.programId).toBe('program_main');
  });

  it('a rejecting start() faults the session instead of escaping to the caller', async () => {
    class BadStart extends FakeBackend {
      override start(): Promise<void> {
        this.calls.push('start');
        return Promise.reject(new Error('start failed'));
      }
    }
    const ctl = new SimulatorController({ backend: () => new BadStart() });
    const r = await ctl.run(build(wired));
    expect(r.ok).toBe(true);
    const s = ctl.getState();
    expect(s.status).toBe('faulted');
    expect(s.diagnostics.map((x) => x.code)).toEqual(['program_runtime_error']);
    expect(s.diagnostics[0]!.message).toContain('start failed');
  });
});
