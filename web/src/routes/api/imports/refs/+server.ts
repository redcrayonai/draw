import { json } from '@sveltejs/kit';
import { verifyBearer } from '$lib/server/http';
import { configured, github, githubPath, importFailure, publicRepository, repositoryUrl } from '$lib/server/imports';
import type { RequestHandler } from './$types';

// Account tokens only where there are accounts (verifyBearer): every call spends three requests against the Worker's shared
// unauthenticated GitHub budget (60/hour per source IP), so an open endpoint
// here lets anonymous traffic rate-limit ref loading for real users.
export const GET: RequestHandler = async ({ request, url }) => {
  const off = configured();
  if (off) return off;
  const token = await verifyBearer(request);
  if (token instanceof Response) return token;
  try {
    const repository = repositoryUrl(url.searchParams.get('repository'));
    const metadata = await publicRepository(repository);
    const [branches, tags] = await Promise.all(['branches', 'tags'].map((kind) => github(`${githubPath(repository)}/${kind}?per_page=100`))) as { name: string; commit: { sha: string } }[][];
    return json({ repository, refs: [...branches.map((r) => ({ ref: r.name, sha: r.commit.sha })), ...tags.map((r) => ({ ref: `refs/tags/${r.name}`, sha: r.commit.sha }))], defaultRef: metadata.default_branch });
  } catch (error) { return importFailure(error); }
};
