/**
 * Speed pacing (plan §4.5).
 *
 * `speed` is virtual time per unit of real time. The pacer translates a virtual
 * timestamp into "how many milliseconds of wall clock must still pass before
 * this event is allowed to fire":
 *
 *     waitMsFor(atUs) = max(0, anchorWallMs + (atUs - anchorUs) / (1000 * speed) - clock.nowMs())
 *
 * It is the only place in the kernel that knows about real time, and it never
 * blocks: the caller either yields the slice or sleeps via the host's timer.
 *
 * The hard invariant it must not break: speed and pausing only move the wall
 * clock. They never change the event order or the `nowUs` sequence.
 */
import type { SimulationSpeed } from '@breadboard-studio/schema';
import type { Pacer, WallClock } from '../contracts.js';

/**
 * Mirror of `SIMULATION_SPEEDS` in `@breadboard-studio/schema`. It is copied
 * instead of imported because a value import from the schema package would drag
 * ajv into the worker chunk (plan §1.3); `pacer.test.ts` pins this list to the
 * schema's so the two can never drift.
 */
export const SUPPORTED_SPEEDS: readonly SimulationSpeed[] = [0.1, 0.25, 0.5, 1, 2, 5, 10];

export interface SpeedPacerOptions {
  clock: WallClock;
  /** Current virtual time. Read whenever the pacer re-anchors itself (`setSpeed`). */
  nowUs: () => number;
  /** Defaults to 1×. */
  speed?: SimulationSpeed;
}

function checkSpeed(speed: SimulationSpeed): SimulationSpeed {
  if (!SUPPORTED_SPEEDS.includes(speed)) throw new Error(`不支持的仿真倍速：${String(speed)}，可选值为 ${SUPPORTED_SPEEDS.join(' / ')}`);
  return speed;
}

export class SpeedPacer implements Pacer {
  private readonly clock: WallClock;
  private readonly virtualNowUs: () => number;
  private current: SimulationSpeed;
  private anchorUs: number;
  private anchorWallMs: number;

  constructor(options: SpeedPacerOptions) {
    this.clock = options.clock;
    this.virtualNowUs = options.nowUs;
    this.current = checkSpeed(options.speed ?? 1);
    this.anchorUs = options.nowUs();
    this.anchorWallMs = options.clock.nowMs();
  }

  get speed(): SimulationSpeed {
    return this.current;
  }

  waitMsFor(atUs: number): number {
    const dueMs = this.anchorWallMs + (atUs - this.anchorUs) / (1000 * this.current);
    const wait = dueMs - this.clock.nowMs();
    // Written as a comparison rather than Math.max so a NaN input yields 0
    // instead of poisoning the caller's timer.
    return wait > 0 ? wait : 0;
  }

  /** Re-anchor to the current wall clock and the given virtual time. */
  reanchor(nowUs: number): void {
    this.anchorUs = nowUs;
    this.anchorWallMs = this.clock.nowMs();
  }

  /**
   * Change speed and re-anchor. Without the re-anchor the old anchor would be
   * re-interpreted at the new rate, and the switch would replay or skip the
   * whole span since the last anchor.
   */
  setSpeed(speed: SimulationSpeed): void {
    this.current = checkSpeed(speed);
    this.reanchor(this.virtualNowUs());
  }
}
