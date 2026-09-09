import { describe, expect, it } from 'vitest';
import { parseRecording } from './RecordingPanel';

const good = JSON.stringify({
  kind: 'breadboard-studio/recording@1',
  designHash: 'abc',
  entries: [{ atUs: 1000, event: { componentId: 'touch', controlId: 'touch', action: 'touch', value: true } }]
});

describe('recording files', () => {
  it('accepts what this app writes', () => {
    const parsed = parseRecording(good);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.entries).toHaveLength(1);
    expect(parsed.file.designHash).toBe('abc');
  });

  it('names the part it could not read instead of failing vaguely', () => {
    const cases: [string, string][] = [
      ['{', 'JSON'],
      ['[]', '对象'],
      [JSON.stringify({ kind: 'something/else', entries: [] }), 'kind'],
      [JSON.stringify({ kind: 'breadboard-studio/recording@1' }), 'entries'],
      [JSON.stringify({ kind: 'breadboard-studio/recording@1', entries: [{ event: { componentId: 'a', controlId: 'b' } }] }), 'atUs'],
      [JSON.stringify({ kind: 'breadboard-studio/recording@1', entries: [{ atUs: 1, event: { componentId: 'a' } }] }), 'controlId']
    ];
    for (const [text, needle] of cases) {
      const parsed = parseRecording(text);
      expect(parsed.ok, text.slice(0, 40)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error, text.slice(0, 40)).toContain(needle);
    }
  });

  it('keeps a recording with no design hash: it is still replayable', () => {
    const parsed = parseRecording(JSON.stringify({ kind: 'breadboard-studio/recording@1', entries: [] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.designHash).toBeNull();
  });
});
