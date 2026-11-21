import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId, type IdKind } from './ids.js';

describe('ids', () => {
  it('creates prefixed ULIDs for every kind', () => {
    for (const kind of Object.keys(ID_PREFIXES) as IdKind[]) {
      const id = newId(kind);
      expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
      expect(isId(kind, id)).toBe(true);
    }
  });

  it('keeps the TRD prefixes', () => {
    expect(ID_PREFIXES.user).toBe('usr');
    expect(ID_PREFIXES.request).toBe('req');
    expect(ID_PREFIXES.company).toBe('cmp');
  });

  it('rejects the wrong prefix, wrong case and wrong length', () => {
    const id = newId('request');
    expect(isId('user', id)).toBe(false);
    expect(isId('request', id.toLowerCase())).toBe(false);
    expect(isId('request', id.slice(0, -1))).toBe(false);
    expect(isId('request', 42)).toBe(false);
  });

  it('is unique and roughly time ordered', () => {
    const a = newId('event');
    const b = newId('event');
    expect(a).not.toBe(b);
  });
});
