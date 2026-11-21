// Hosted capture hooks already use apply_board. Give the local batch its own name.
export const localToolName = (name: string) => name === 'apply_board' ? 'apply_local_board' : name;
export const isLocalTool = (name: string) => ['open_board', 'read_board', 'list_boards', 'apply_local_board', 'read_code', 'attach_conversation'].includes(name);

const localSlug = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function assertHostedArguments(input: Record<string, unknown>) {
  if ('repo' in input || ('board' in input && (typeof input.board !== 'string' || !/^\d+$/.test(input.board)))) {
    throw new Error('Use the local board tools for repository paths and local board IDs.');
  }
  if (typeof input.link === 'string') {
    // The hosted server also accepts bare board identifiers and URL fragments.
    if (/^[a-zA-Z0-9_-]+$/.test(input.link) && !localSlug.test(input.link)) return;
    const link = new URL(input.link, input.link.startsWith('#') ? 'https://draw.invalid' : undefined);
    const fragment = new URLSearchParams(link.hash.slice(1));
    if (fragment.has('key') || fragment.has('local') || localSlug.test(fragment.get('b') ?? '')) {
      throw new Error('Use read_board for a local board link.');
    }
  }
}
