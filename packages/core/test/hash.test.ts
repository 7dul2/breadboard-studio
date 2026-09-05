import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex, canonicalJson } from '../src/hash.js';

describe('sha256', () => {
  it('matches node crypto for several inputs', () => {
    for (const s of ['', 'abc', 'breadboard studio', 'x'.repeat(200), '你好，面包板 🙂']) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
  it('canonical json sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [3, { z: 1, y: undefined }] })).toBe('{"a":[3,{"z":1}],"b":1}');
  });
});
