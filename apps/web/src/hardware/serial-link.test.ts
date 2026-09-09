import { describe, expect, it } from 'vitest';
import { appendLines, detectSerialSupport, LineDecoder, MAX_LINES } from './serial-link';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('serial support detection', () => {
  it('names the reason instead of hiding the feature', () => {
    expect(detectSerialSupport({ serial: {} }, true)).toEqual({ supported: true });

    const noApi = detectSerialSupport({}, true);
    expect(noApi.supported).toBe(false);
    if (noApi.supported) return;
    expect(noApi.reason).toBe('no-api');
    expect(noApi.message, 'says which browsers do support it').toContain('Chrome');

    const insecure = detectSerialSupport({ serial: {} }, false);
    expect(insecure.supported).toBe(false);
    if (insecure.supported) return;
    expect(insecure.reason).toBe('insecure-context');
    expect(insecure.message).toContain('localhost');

    expect(detectSerialSupport(undefined, true).supported, 'no navigator at all').toBe(false);
  });
});

describe('line decoding', () => {
  it('emits only complete lines and strips CR', () => {
    const d = new LineDecoder();
    expect(d.push(bytes('ready\nboot\r\n'))).toEqual(['ready', 'boot']);
    expect(d.push(bytes('')), 'nothing pending').toEqual([]);
  });

  it('holds a partial line until the rest arrives', () => {
    const d = new LineDecoder();
    expect(d.push(bytes('hel')), 'no newline yet').toEqual([]);
    expect(d.push(bytes('lo\nwor'))).toEqual(['hello']);
    expect(d.push(bytes('ld\n'))).toEqual(['world']);
  });

  it('holds a multi-byte character split across chunks', () => {
    // "温度" is six UTF-8 bytes; cut one character in half.
    const full = bytes('温度: 25\n');
    const d = new LineDecoder();
    expect(d.push(full.slice(0, 4)), 'half of 度 has arrived').toEqual([]);
    expect(d.push(full.slice(4)), 'and now it decodes whole').toEqual(['温度: 25']);
  });

  it('gives back the unterminated tail when the port closes', () => {
    const d = new LineDecoder();
    d.push(bytes('done\npartial'));
    expect(d.flush()).toEqual(['partial']);
    expect(d.flush(), 'and only once').toEqual([]);
  });

  it('keeps empty lines, because a board printing blank lines is saying something', () => {
    const d = new LineDecoder();
    expect(d.push(bytes('a\n\nb\n'))).toEqual(['a', '', 'b']);
  });
});

describe('console buffer', () => {
  it('keeps the most recent lines and drops the oldest', () => {
    const many = Array.from({ length: MAX_LINES + 50 }, (_, i) => ({ text: `line ${i}`, atMs: i }));
    const kept = appendLines([], many);
    expect(kept).toHaveLength(MAX_LINES);
    expect(kept[0]!.text, 'the first 50 fell off the front').toBe('line 50');
    expect(kept.at(-1)!.text).toBe(`line ${MAX_LINES + 49}`);
  });

  it('appends without copying the world when it is under the cap', () => {
    const first = appendLines([], [{ text: 'a', atMs: 1 }]);
    expect(appendLines(first, [{ text: 'b', atMs: 2 }]).map((l) => l.text)).toEqual(['a', 'b']);
  });
});
