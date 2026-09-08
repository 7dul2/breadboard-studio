import { describe, it, expect } from 'vitest';
import { SIM_COMMANDS, SIM_STATUSES, SIM_TRANSITIONS, SimulatorStateMachine, allowedCommands, canEditTopology, transition } from '../src/index.js';

describe('simulator state machine', () => {
  it('follows the documented happy path: run → compile → prepare → run → pause → step → reset', () => {
    const m = new SimulatorStateMachine();
    expect(m.status).toBe('idle');
    expect(m.dispatch('run')).toMatchObject({ ok: true, to: 'compiling' });
    expect(m.dispatch('compiled')).toMatchObject({ ok: true, to: 'prepared' });
    expect(m.dispatch('run')).toMatchObject({ ok: true, to: 'running' });
    expect(m.dispatch('pause')).toMatchObject({ ok: true, to: 'paused' });
    expect(m.dispatch('step')).toMatchObject({ ok: true, to: 'stepping' });
    expect(m.dispatch('stepped')).toMatchObject({ ok: true, to: 'paused' });
    expect(m.dispatch('reset')).toMatchObject({ ok: true, to: 'prepared' });
    expect(m.dispatch('pause')).toMatchObject({ ok: true, to: 'paused' });
    expect(m.dispatch('run')).toMatchObject({ ok: true, to: 'running' });
    expect(m.dispatch('fault')).toMatchObject({ ok: true, to: 'faulted' });
    expect(m.dispatch('reset')).toMatchObject({ ok: true, to: 'compiling' });
    expect(m.dispatch('stop')).toMatchObject({ ok: true, to: 'idle' });
    expect(m.history.every((t) => t.ok)).toBe(true);
  });

  it('rejects illegal commands without changing state', () => {
    const m = new SimulatorStateMachine();
    for (const event of ['pause', 'step', 'reset', 'stop', 'compiled', 'stepped', 'fault', 'topology_changed'] as const) {
      const t = m.dispatch(event);
      expect(t.ok, event).toBe(false);
      if (!t.ok) expect(t.reason).toContain('idle');
      expect(m.status).toBe('idle');
    }
    m.dispatch('run');
    expect(m.dispatch('step').ok).toBe(false);
    expect(m.dispatch('pause').ok).toBe(false);
    expect(m.status).toBe('compiling');
    expect(transition('running', 'run').ok).toBe(false);
    expect(transition('stepping', 'run').ok).toBe(false);
    expect(transition('faulted', 'run').ok).toBe(false);
  });

  it('leaves any non-idle state on stop or topology change', () => {
    for (const state of SIM_STATUSES) {
      if (state === 'idle') continue;
      expect(transition(state, 'stop'), state).toMatchObject({ ok: true, to: 'idle' });
      expect(transition(state, 'topology_changed'), state).toMatchObject({ ok: true, to: 'idle' });
    }
    expect(canEditTopology('idle')).toBe(true);
    expect(canEditTopology('faulted')).toBe(true);
    for (const state of ['compiling', 'prepared', 'running', 'paused', 'stepping'] as const) expect(canEditTopology(state), state).toBe(false);
  });

  it('exposes the allowed command set per state for the toolbar', () => {
    expect(allowedCommands('idle')).toEqual(['run']);
    expect(allowedCommands('running')).toEqual(['pause', 'reset', 'stop']);
    expect(allowedCommands('paused')).toEqual(['run', 'step', 'reset', 'stop']);
    expect(allowedCommands('faulted')).toEqual(['reset', 'stop']);
    for (const state of SIM_STATUSES) {
      for (const command of SIM_COMMANDS) {
        expect(allowedCommands(state).includes(command)).toBe(SIM_TRANSITIONS[state][command] !== undefined);
      }
    }
  });
});
