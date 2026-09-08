/**
 * Errors from sucrase and QuickJS → `SimDiagnostic` (plan §6.7).
 *
 * The rules here are fixed by measurement, not taste:
 *  - sucrase's `e.loc` is missing for some inputs (`const a = @;` throws with
 *    no `loc` at all), so the documented fallback is `(1, 1)` and the UI
 *    highlights the whole line instead of pointing a column caret;
 *  - a QuickJS `SyntaxError` carries structured `fileName` / `lineNumber` /
 *    `columnNumber` (1-based column) — use them, do not parse the message;
 *  - a runtime error only has `stack`, whose first frame belonging to the
 *    program file is the interesting one.
 */
import { SIM_DIAGNOSTIC_SEVERITY, type SimDiagnostic, type SimSourceLocation } from '../types.js';

/** Both `at loop (program_main.ts:5:19)` and `at program_main.ts:9:1` parse with this. */
const FRAME = /at\s+(?:[^\s(]+\s+)?\(?([^\s():]+):(\d+):(\d+)\)?/;

/** The shape of a QuickJS error handle after `ctx.dump()` plus the extra props we read. */
export interface GuestErrorShape {
  name?: string;
  message?: string;
  stack?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** QuickJS reports a spent interrupt budget as `InternalError: interrupted`. */
export function isInterruptError(error: unknown): boolean {
  const e = error as GuestErrorShape | null;
  return !!e && e.name === 'InternalError' && e.message === 'interrupted';
}

/** Human-readable one-liner for any thrown value. */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as GuestErrorShape;
    if (typeof e.message === 'string') return e.name ? `${e.name}: ${e.message}` : e.message;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * First stack frame that belongs to `filename`. Frames from the host probe
 * (`<bbs:probe>`) and from guest library modules are skipped so the location
 * always lands in code the user wrote.
 */
export function firstFrameIn(stack: string | undefined, filename: string): { line: number; column: number } | null {
  if (!stack) return null;
  for (const raw of stack.split('\n')) {
    const match = FRAME.exec(raw);
    if (!match) continue;
    if (match[1] !== filename) continue;
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
    return { line, column };
  }
  return null;
}

/** sucrase throws a babel-shaped error; `loc` is present for most inputs and absent for some. */
export function locationFromSucraseError(error: unknown, programId: string): SimSourceLocation {
  const loc = (error as { loc?: { line?: unknown; column?: unknown } } | null)?.loc;
  const line = typeof loc?.line === 'number' && Number.isFinite(loc.line) ? loc.line : 1;
  const column = typeof loc?.column === 'number' && Number.isFinite(loc.column) ? loc.column : 1;
  return { programId, line, column };
}

/**
 * Location for an error raised inside the VM: structured properties first
 * (that is what a `SyntaxError` carries), then the first program frame of the
 * stack, then `(1, 1)`.
 */
export function locationFromGuestError(error: GuestErrorShape | null | undefined, programId: string): SimSourceLocation {
  if (error) {
    if (typeof error.lineNumber === 'number' && Number.isFinite(error.lineNumber) && (error.fileName === undefined || error.fileName === programId)) {
      const column = typeof error.columnNumber === 'number' && Number.isFinite(error.columnNumber) ? error.columnNumber : 1;
      return { programId, line: error.lineNumber, column };
    }
    const frame = firstFrameIn(error.stack, programId);
    if (frame) return { programId, ...frame };
  }
  return { programId, line: 1, column: 1 };
}

export function compileErrorDiagnostic(message: string, source: SimSourceLocation): SimDiagnostic {
  return {
    code: 'program_compile_error',
    severity: SIM_DIAGNOSTIC_SEVERITY.program_compile_error,
    message,
    source
  };
}

export function runtimeErrorDiagnostic(message: string, source: SimSourceLocation, atUs?: number): SimDiagnostic {
  return {
    code: 'program_runtime_error',
    severity: SIM_DIAGNOSTIC_SEVERITY.program_runtime_error,
    message,
    source,
    ...(atUs === undefined ? {} : { atUs })
  };
}

/**
 * `execution_budget_exceeded` for a spent wall-clock slice. The location comes
 * from the interrupt handler's own sample (`StudioTsSandbox.trippedSource()`),
 * which points at the hot line rather than the function declaration.
 */
export function budgetExceededDiagnostic(message: string, source?: SimSourceLocation, atUs?: number): SimDiagnostic {
  return {
    code: 'execution_budget_exceeded',
    severity: SIM_DIAGNOSTIC_SEVERITY.execution_budget_exceeded,
    message,
    ...(source ? { source } : {}),
    ...(atUs === undefined ? {} : { atUs })
  };
}
