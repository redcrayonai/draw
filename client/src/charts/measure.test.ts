import { describe, it, expect, vi } from 'vitest';

// A proportional face like Geist: about 0.5 em per character, mono 0.6 em.
// Charts must lay out with this measure, not a fixed 0.6 em guess (M6).
vi.mock('../node-text', () => ({
  textWidth: vi.fn((text: string, size: number, mono = false) => [...text].length * size * (mono ? 0.6 : 0.5)),
}));
const nodeText = await import('../node-text');

const { legend } = await import('./svg');
const { renderWaterfall } = await import('./waterfall');
const { renderPlot } = await import('./index');
const { group } = await import('./test-util');
const { samplePlacement } = await import('../library');
const { parseChart } = await import('../../../module/src/chart-contracts');

describe('chart text uses the real measure (M6)', () => {
  it("a legend keeps 'ap-south' when it fits, instead of folding it into +1", () => {
    // Widths Chrome measures for 500 11px Geist (probe of the 224x144 card): 39.4, 42.3, 46.6 px.
    const real: Record<string, number> = { 'us-east': 39.42, 'eu-west': 42.3, 'ap-south': 46.64 };
    const measured = vi.spyOn(nodeText, 'textWidth').mockImplementation((text: string) => real[text] ?? text.length * 5.5);
    const tight = [...legend(['us-east', 'eu-west', 'ap-south'].map((name, i) => ({ name, cls: `series-${i + 1}` })), 0, 100, 192).querySelectorAll('text')];
    expect(tight.map(t => t.textContent)).toEqual(['us-east', 'eu-west', 'ap-south']);
    measured.mockRestore();

    const items = ['us-east', 'eu-west', 'ap-south'].map((name, i) => ({ name, cls: `series-${i + 1}` }));
    // the 224x144 card: a 192 px plot
    const texts = [...legend(items, 0, 100, 192).querySelectorAll('text')].map(t => t.textContent);
    expect(texts).toEqual(['us-east', 'eu-west', 'ap-south']);
  });

  it('waterfall names are cut by their real width, not early', () => {
    const d = {
      type: 'waterfall' as const,
      options: {},
      spans: [
        { id: '1', parentId: '', name: 'POST /checkout', service: 'web', start: 0, duration: 420, status: 'ok' as const, depth: 0 },
        { id: '2', parentId: '1', name: 'inventory.reserve', service: 'cart', start: 136, duration: 44, status: 'ok' as const, depth: 1 },
      ],
      services: ['web', 'cart'],
      end: 420,
    };
    const g = group(renderWaterfall(d, { x: 0, y: 0, w: 320, h: 140 }, false));
    expect([...g.querySelectorAll('text.chart-label')].map(t => t.textContent)).toEqual(['POST /checkout', 'inventory.reserve']);
  });

  it('the library schedule sample labels every item, at its width', () => {
    const { w, h, csv } = samplePlacement('schedule');
    const r = parseChart('schedule', csv, '{}');
    if (!r.ok) throw new Error(r.error);
    // the card's plot box: 16 px sides, 56 px above, 28 px below
    const g = group(renderPlot(r.data, { x: 0, y: 0, w: w - 32, h: h - 84 }, false));
    const drawn = [...g.querySelectorAll('text.chart-label')].map(t => t.textContent);
    expect(drawn).toEqual(expect.arrayContaining(['✓ schema v2', 'backfill', 'cutover', '✓ dual writes', 'read switch', 'checkout v2', 'load test', 'launch']));
    expect(g.querySelector('.chart-more')).toBeNull();
  });
});
