import type { DesignDocument, ProgramAsset } from '@breadboard-studio/schema';

/** Programs whose target is `componentId`, in file order. */
export function programsForComponent(design: DesignDocument, componentId: string): ProgramAsset[] {
  return (design.programs ?? []).filter((p) => p.target_component_id === componentId);
}

/** The program `simulation.active_program_id` points at, or the first program when none is set. */
export function activeProgram(design: DesignDocument): ProgramAsset | null {
  const programs = design.programs ?? [];
  const id = design.simulation?.active_program_id;
  if (id !== undefined) return programs.find((p) => p.id === id) ?? null;
  return programs[0] ?? null;
}

/** Next unused `program_<n>` id across every object kind in the design. */
export function nextProgramId(design: DesignDocument, prefix = 'program_'): string {
  const used = new Set([...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints, ...(design.programs ?? [])].map((o) => o.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
