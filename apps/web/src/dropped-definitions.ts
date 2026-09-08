import type { DesignDocument } from '@breadboard-studio/schema';

/**
 * Embedded definitions the incoming document would drop while its own models
 * still use them.
 *
 * `replace_design` deletes `embedded_catalog` outright when the incoming document
 * has none (`packages/core/src/ops.ts`), which silently reverts a custom drawing
 * to the built-in one. For 新建 / 导入 / 载入示例 that is what the user asked for —
 * a different project — and the old document is stashed as 上一个项目 anyway. The
 * DSL panel is the one place it happens *inside* the same project: a draft taken
 * before the artwork was saved still parses, still applies, and quietly takes the
 * drawing with it. That is worth a word.
 */
export function droppedDefinitions(current: DesignDocument, next: DesignDocument): string[] {
  const refs = (d: DesignDocument) =>
    new Set([...(d.embedded_catalog?.boards ?? []), ...(d.embedded_catalog?.components ?? [])].map((x) => `${x.id}@${x.version}`));
  const before = refs(current);
  if (!before.size) return [];
  const after = refs(next);
  const used = new Set([...next.boards, ...next.components].map((o) => o.model));
  return [...before].filter((ref) => !after.has(ref) && used.has(ref)).sort();
}
