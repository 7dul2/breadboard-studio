import type { BoardDefinition, DesignDocument } from '@breadboard-studio/schema';
import { loadDesign } from '@breadboard-studio/core';

export interface DemotedFacet {
  id: string;
  kind: 'board' | 'component';
  facet: 'geometry' | 'electrical';
}

export interface RecoveryResult {
  design: DesignDocument;
  demoted: DemotedFacet[];
}

/** 「id@版本（几何/电气）、…」— for disclosure toasts. */
export function describeDemoted(demoted: DemotedFacet[]): string {
  return demoted.map((x) => `${x.id}（${x.facet === 'geometry' ? '几何' : '电气'}）`).join('、');
}

/**
 * 「显式降级」恢复（docs/VERIFICATION.md §流转 4）：一个旧文件里若有内嵌定义
 * 标着 verified 却没有 evidence 记录，新校验会整文件拒绝——对“项目 → 导入”
 * 或本地自动恢复来说，那就是整个项目打不开。这里的处理不是放行校验，而是把
 * 那些无凭据的 verified 声明改成 approximate、把降级写进 status_notes，然后
 * 用**同一套**校验重新载入：降级之后仍然不合法的文件返回 null（该报错就报错）。
 * 原始文件不被改动；调用方负责把发生了什么完整告诉用户。
 *
 * 这是自动虚构记录的反面：不添加任何 evidence，只削弱一个拿不出证据的声明。
 */
export function recoverByExplicitDowngrade(text: string): RecoveryResult | null {
  let doc: DesignDocument;
  try {
    doc = JSON.parse(text) as DesignDocument;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !doc.embedded_catalog) return null;
  const today = new Date().toISOString().slice(0, 10);
  const note = `；${today} 显式降级：原值 verified 缺少可追溯 evidence（docs/VERIFICATION.md）`;
  const demoted: DemotedFacet[] = [];
  for (const kind of ['boards', 'components'] as const) {
    for (const def of doc.embedded_catalog[kind] ?? []) {
      // Both definition kinds carry the same status fields; Pick keeps the
      // computed key well-typed across the union.
      const status = def as Pick<BoardDefinition, 'geometry_status' | 'electrical_status' | 'status_notes'>;
      for (const facet of ['geometry', 'electrical'] as const) {
        const key = `${facet}_status` as 'geometry_status' | 'electrical_status';
        if (status[key] !== 'verified') continue;
        status[key] = 'approximate';
        status.status_notes = `${status.status_notes ?? ''}${note}`;
        demoted.push({ id: `${def.id}@${def.version}`, kind: kind === 'boards' ? 'board' : 'component', facet });
      }
    }
  }
  if (!demoted.length) return null;
  const r = loadDesign(doc);
  if (!r.ok || !r.design) return null;
  return { design: r.design, demoted };
}
