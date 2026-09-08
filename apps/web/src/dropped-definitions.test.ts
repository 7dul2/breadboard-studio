import { describe, expect, it } from 'vitest';
import type { DesignDocument } from '@breadboard-studio/schema';
import { droppedDefinitions } from './dropped-definitions';

const def = (id: string, version = 1) => ({ kind: 'component', id, version, name: id }) as never;

function doc(opts: { models?: string[]; embedded?: string[] } = {}): DesignDocument {
  return {
    schema_version: '1.1',
    metadata: { name: 'x', revision: 1 },
    boards: [{ id: 'bb', model: 'breadboard_400@1', position_um: [0, 0] }],
    components: (opts.models ?? []).map((m, i) => ({ id: `c${i}`, model: m })),
    wires: [],
    ...(opts.embedded ? { embedded_catalog: { components: opts.embedded.map((r) => def(r.split('@')[0]!, Number(r.split('@')[1]))) } } : {})
  } as unknown as DesignDocument;
}

describe('droppedDefinitions', () => {
  it('names a custom drawing the draft would silently revert to the built-in one', () => {
    const current = doc({ models: ['esp32s3_n16r8_dual_usb@1'], embedded: ['esp32s3_n16r8_dual_usb@1'] });
    const draft = doc({ models: ['esp32s3_n16r8_dual_usb@1'] });
    expect(droppedDefinitions(current, draft)).toEqual(['esp32s3_n16r8_dual_usb@1']);
  });

  it('says nothing when the draft carries the definition through', () => {
    const current = doc({ models: ['ttp223_module@1'], embedded: ['ttp223_module@1'] });
    expect(droppedDefinitions(current, current)).toEqual([]);
  });

  it('says nothing when the model itself is gone: no drawing is being reverted', () => {
    const current = doc({ models: ['ttp223_module@1'], embedded: ['ttp223_module@1'] });
    expect(droppedDefinitions(current, doc({ models: [] }))).toEqual([]);
  });

  it('treats a different version as a different definition', () => {
    const current = doc({ models: ['ttp223_module@1'], embedded: ['ttp223_module@1'] });
    expect(droppedDefinitions(current, doc({ models: ['ttp223_module@1'], embedded: ['ttp223_module@2'] }))).toEqual(['ttp223_module@1']);
  });

  it('is empty when nothing was embedded to begin with', () => {
    expect(droppedDefinitions(doc({ models: ['ttp223_module@1'] }), doc())).toEqual([]);
  });

  it('reports every affected model, sorted', () => {
    const current = doc({ models: ['b@1', 'a@1'], embedded: ['b@1', 'a@1'] });
    expect(droppedDefinitions(current, doc({ models: ['a@1', 'b@1'] }))).toEqual(['a@1', 'b@1']);
  });
});
