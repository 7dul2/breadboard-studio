export type Severity = 'error' | 'warning' | 'info' | 'needs_review';
export type RuleCategory = 'schema' | 'placement' | 'board' | 'wire' | 'net' | 'interface' | 'evidence';

export interface RuleResult {
  severity: Severity;
  code: string;
  category: RuleCategory;
  message: string;
  /** Ids of related boards/components/wires/net intents. */
  objects: string[];
  /** Related hole/terminal addresses. */
  endpoints?: string[];
  suggestion?: string;
  /**
   * Blocking results describe a structurally or physically impossible design
   * (bad reference, pin off grid, two pins in one hole). Transactions refuse to
   * commit them. Electrical problems are never blocking: they stay in the draft
   * and are reported prominently.
   */
  blocking: boolean;
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, needs_review: 2, info: 3 };

export function sortResults(results: RuleResult[]): RuleResult[] {
  return [...results].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
}

export function summarize(results: RuleResult[]): Record<Severity, number> & { blocking: number } {
  const s = { error: 0, warning: 0, info: 0, needs_review: 0, blocking: 0 };
  for (const r of results) {
    s[r.severity]++;
    if (r.blocking) s.blocking++;
  }
  return s;
}
