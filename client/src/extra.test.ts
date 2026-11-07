import { describe, expect, it } from 'vitest';
import extra from '$extra';
import none from './extra';

// The swap itself (VITE_CANVAS_EXTRA at build time) runs in e2e/tests/canvas-extra.spec.ts.
describe('canvas extra seam', () => {
  it('a build without VITE_CANVAS_EXTRA gets the empty module, which adds nothing', () => {
    expect(extra).toBe(none);
    expect(Object.keys(none)).toEqual([]);
  });
});
