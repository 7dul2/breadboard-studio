import type { DesignDocument } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { buildModel, type DesignModel } from './model.js';
import { checkModel } from './rules.js';
import type { Connectivity } from './connectivity.js';
import { sortResults, summarize, type RuleResult } from './results.js';

export interface Analysis {
  model: DesignModel;
  connectivity: Connectivity;
  results: RuleResult[];
  summary: ReturnType<typeof summarize>;
  hasBlocking: boolean;
}

/** Build the model, run connectivity and every rule. Shared by the editor and the CLI. */
export function analyzeDesign(design: DesignDocument, catalog: Catalog = builtinCatalog()): Analysis {
  const model = buildModel(design, catalog);
  const { results, connectivity } = checkModel(model);
  const sorted = sortResults(results);
  return { model, connectivity, results: sorted, summary: summarize(sorted), hasBlocking: sorted.some((r) => r.blocking) };
}
