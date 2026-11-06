import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const h = vi.hoisted(() => ({
  config: {
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
    mcpUrl: 'https://mcp.example.com/mcp' as string | undefined,
    privacyUrl: undefined as string | undefined,
  },
}));
vi.mock('$lib/config', () => ({ config: h.config }));

import Page from './+page.svelte';
import { CONNECT_FOOTER } from '$shared/connect-guide';

/** No vendor, env var, socket URL or DB host on the page (hosted MCP §12). */
function expectNoLeak(text: string) {
  expect(text).not.toMatch(/spacetime|maincloud|bsatn|clockwork|\bstdb\b/i);
  expect(text.replaceAll('REDCRAYON_MCP_URL', '')).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  expect(text).not.toMatch(/npx -y redcrayon-mcp|tsx|wss?:\/\/|localhost|127\.0\.0\.1|redcrayon-test/);
}

beforeEach(() => {
  h.config.mcpUrl = 'https://mcp.example.com/mcp';
  h.config.privacyUrl = undefined;
});

describe('privacy policy link', () => {
  it('follows the disclosure only when the build names a policy', () => {
    render(Page);
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    h.config.privacyUrl = 'https://example.com/privacy';
    render(Page);
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://example.com/privacy');
  });
});

describe('agent setup page', () => {
  it('shows the hosted URL and the five clients the canvas dialog offers', () => {
    const { container } = render(Page);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Connect your coding agent');
    expect(container.querySelector('pre code')!.textContent).toBe('https://mcp.example.com/mcp');
    expect(screen.getAllByRole('heading', { level: 2 }).map(e => e.textContent)).toEqual([
      'Server URL',
      'Claude Code',
      'Cursor',
      'Codex',
      'claude.ai',
      'Other',
    ]);
    const codes = [...container.querySelectorAll('code')].map(c => c.textContent);
    expect(codes).toContain('claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai');
    expect(codes).toContain('codex plugin marketplace add redcrayonai/draw && codex plugin add draw@redcrayonai');
    expect(codes).toContain("REDCRAYON_MCP_URL='https://mcp.example.com/mcp' codex");
    expect(container.textContent).toContain('shared app server');
    expect(screen.getByRole('link', { name: 'add to Cursor' }).getAttribute('href')).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=draw&config=/);
    for (const line of CONNECT_FOOTER) expect(screen.getByText(line)).toBeInTheDocument();
    expectNoLeak(container.textContent ?? '');
  });

  it('explains when this server has no agent connection URL', () => {
    h.config.mcpUrl = undefined;
    const { container } = render(Page);
    expect(screen.getByText('Agent connections are not configured for this server.')).toBeInTheDocument();
    expect(container.querySelector('pre, code, ol')).toBeNull();
    expectNoLeak(container.textContent ?? '');
  });
});
