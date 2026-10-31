// Storage limits (security audit 2026-10-30). The write budget (spendWrite)
// counts calls; these bound what one call, board or identity can keep in the
// shared database. ISSUERS.limits switches them, from REDCRAYON_LIMITS=on at
// publish (scripts/module-env.mjs; off by default, since they also refuse writes
// to data stored before them). Service accounts are never limited.
//
// The per-call, per-path, doc and branch limits hold for anyone. The per-owner
// board and seat limits only bound one identity, and identities are free to mint
// (POST /v1/identity): they stop an honest client, not a script. A global count
// or a rate limit on minting at the edge is the abuse control.
export const LIMITS = {
  /** add_repo_files: paths per call (the agent sends 200, REPO_FILE_CHUNK). */
  repoFilesPerCall: 5_000,
  /** add_repo_files: characters per path (Linux PATH_MAX; git lists deep paths). */
  repoPathChars: 4_096,
  /** Repo files one board keeps: start_session registers every tracked file, so this is also the largest repo a session takes. */
  repoFilesPerBoard: 50_000,
  /** Characters in a node doc. */
  docChars: 65_536,
  /** Boards an identity owns without a signed-in account (guests, unlinked agents). */
  boardsPerGuest: 20,
  /** Boards a signed-in person owns, their linked agents' boards included. */
  boardsPerAccount: 500,
  /** Nodes on a board that can still be forked into a branch. */
  forkMaxNodes: 2_000,
  /** Branches one board can have. */
  forksPerBase: 20,
  /** Waiting mark seats one identity keeps on a board; a new seat replaces its oldest. */
  waitersPerIdentity: 4,
} as const;
