import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { loadDesign, createEmptyDesign, serializeDesign } from '@breadboard-studio/core';
import { recoverByExplicitDowngrade } from './recover-embedded';

function fileWithEmbedded(mutate: (def: Record<string, unknown>) => void): string {
  const def = structuredClone(builtinCatalog().getComponent('oled_0_96_i2c@1')!) as unknown as Record<string, unknown>;
  mutate(def);
  const d = createEmptyDesign('恢复测试');
  d.embedded_catalog = { components: [def as never] };
  return JSON.stringify({ ...JSON.parse(serializeDesign(d)) });
}

describe('recoverByExplicitDowngrade', () => {
  it('demotes evidence-free verified claims and reloads under the same gate', () => {
    const text = fileWithEmbedded((def) => {
      def.geometry_status = 'verified';
      def.electrical_status = 'verified';
    });
    expect(loadDesign(text).ok).toBe(false); // 新门槛先拒绝整个文件
    const rec = recoverByExplicitDowngrade(text);
    expect(rec).not.toBeNull();
    expect(rec!.demoted.map((x) => `${x.id}:${x.facet}`).sort()).toEqual(['oled_0_96_i2c@1:electrical', 'oled_0_96_i2c@1:geometry']);
    expect(rec!.design.embedded_catalog?.components?.[0]?.geometry_status).toBe('approximate');
    expect(rec!.design.embedded_catalog?.components?.[0]?.status_notes).toContain('显式降级');
    // 降级后的文件本身通过校验，且没有虚构任何 evidence
    expect(rec!.design.embedded_catalog?.components?.[0]?.evidence ?? []).toHaveLength(0);
  });

  it('returns null when there is nothing to demote', () => {
    expect(recoverByExplicitDowngrade(fileWithEmbedded(() => {}))).toBeNull();
    expect(recoverByExplicitDowngrade(JSON.stringify(createEmptyDesign('无内嵌')))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(recoverByExplicitDowngrade('{not json')).toBeNull();
  });

  it('returns null when a downgrade is not enough to make the file valid', () => {
    const text = fileWithEmbedded((def) => {
      def.electrical_status = 'verified';
      delete def.render; // 另一处必填字段缺失：降级救不了，应如实报错
    });
    expect(recoverByExplicitDowngrade(text)).toBeNull();
  });
});
