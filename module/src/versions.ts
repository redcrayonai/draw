// Versions plugin (PLUGINS.md): saved versions of a board, kept in operator storage by the
// dashboard server, listed here once stored, and restored into a new private board. The bundle
// format, its capture and its restore are core (board-bundle.ts); this file owns the index, the
// four actions and their rules. Every action checks the caller's current access and the plugin.
import { table, t, SenderError } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { BUNDLE_VERSION, MAX_BUNDLE_BYTES, BundleError, bundleText, captureBoard, parseBundle, restoreBoard } from './board-bundle';
import { sha256Bytes } from './sha256';
import { pluginEnabled } from './plugins';
import { roleRank } from './workspace-policy';
import { assignBoardWorkspace, humanBoardRole, membership } from './workspaces';

export const versionTables = {
  // One row per version. objectKey is unique and never reused; status is 'pending' from capture
  // until the dashboard server stored the object and published it, then 'ready'.
  boardVersion: table({}, {
    id: t.u64().primaryKey().autoInc(),
    workspaceId: t.u64().index('btree'),
    boardId: t.u64().index('btree'),
    boardName: t.string(),
    objectKey: t.string().unique(),
    sha256: t.string(), // of the whole bundle file
    bytes: t.u64(),
    formatVersion: t.u32(),
    status: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
  }),
  // When each person may next save (`capture:<identity>`) or restore (`restore:<identity>`) after a large one. Private.
  versionCooldown: table({}, { key: t.string().primaryKey(), until: t.timestamp() }),
  // A bundle on its way into restoreBoardVersion, in pieces under the 2 MiB call limit. Private.
  boardVersionChunk: table({}, {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    versionId: t.u64(),
    requestKey: t.string(),
    index: t.u32(),
    data: t.string(),
  }),
};

const fail = (sentence: string): never => { throw new SenderError(`version rule: ${sentence}`); };
const admin = (ctx: any, workspaceId: bigint) => ['owner', 'admin'].includes(membership(ctx, workspaceId)?.role);
const boardScope = (ctx: any, boardId: bigint) => ctx.db.boardWorkspace.boardId.find(boardId)?.workspaceId;
const OFF = 'the Versions plugin is off in this workspace; a workspace owner or admin can turn it on';
const MIB = 1048576;

// The version's own board, still in the version's workspace, at `rank` or better; or a workspace
// owner or admin (every board's manager, and the only way to a deleted or moved board's versions).
function mayUse(ctx: any, s: any, rank: number): boolean {
  if (admin(ctx, s.workspaceId)) return true;
  return boardScope(ctx, s.boardId) === s.workspaceId && roleRank(humanBoardRole(ctx, s.boardId)) >= rank;
}

export interface VersionHooks {
  reducer: any;
  isHuman: (ctx: any) => boolean;
  assertService: (ctx: any) => void;
  spendWrite: (ctx: any) => void;
  assertBoardName: (name: string) => void;
  insertBoard: (ctx: any, name: string) => any;
  initCallerBoard: (ctx: any, boardId: bigint, name: string, via: string) => void;
  refreshStats: (ctx: any, boardId: bigint) => void;
  emit: (ctx: any, boardId: bigint, type: string, payload: Record<string, unknown>) => void;
}

export function versionFeatures(db: any, hooks: VersionHooks): any {
  const reducer = hooks.reducer;
  const human = (ctx: any) => { if (!hooks.isHuman(ctx)) fail('sign in with a human account'); };

  function restorable(ctx: any, versionId: bigint): any {
    human(ctx);
    const s = ctx.db.boardVersion.id.find(versionId);
    if (!s || s.status !== 'ready' || !membership(ctx, s.workspaceId)) fail('this version is unavailable');
    if (!pluginEnabled(ctx, s.workspaceId, 'versions')) fail(OFF);
    if (membership(ctx, s.workspaceId).role === 'guest' || !mayUse(ctx, s, 2)) fail('restoring needs edit access to the board and full workspace membership');
    return s;
  }

  const Version = t.row('MyBoardVersion', {
    id: t.u64().primaryKey(), workspaceId: t.u64(), boardId: t.u64(), boardName: t.string(), objectKey: t.string(), sha256: t.string(),
    bytes: t.u64(), formatVersion: t.u32(), createdBy: t.identity(), creatorName: t.string(), createdAt: t.timestamp(),
  });

  /**
   * A procedure's work, as JSON: its result, or { error, refused } (refused: a rule said no; else it failed).
   * The write it spends commits in a transaction of its own, so a refused or failed call still costs one:
   * a reducer's refusal rolls its spend back, which would make these large reads and checks free to repeat.
   */
  function charged(ctx: any, kind: 'capture' | 'restore', work: (tx: any, read: (bytes: number) => void) => Record<string, unknown>): string {
    const out = (e: unknown) => JSON.stringify({ error: e instanceof Error ? e.message : String(e), refused: e instanceof SenderError });
    const key = `${kind}:${ctx.sender.toHexString()}`;
    try {
      ctx.withTx((tx: any) => {
        hooks.spendWrite(tx);
        const wait = (tx.db.versionCooldown.key.find(key)?.until.microsSinceUnixEpoch ?? 0n) - tx.timestamp.microsSinceUnixEpoch;
        if (wait > 0n) fail(`a large version was just ${kind === 'capture' ? 'saved' : 'restored'}; try again in ${Math.ceil(Number(wait) / 1e6)} s`);
      });
    } catch (e) { return out(e); }
    let bytes = 0, result: string;
    try { result = JSON.stringify(ctx.withTx((tx: any) => work(tx, (n: number) => { bytes = n; }))); } catch (e) { result = out(e); }
    // A second per MiB read and checked, refused or not: one person cannot keep the database busy with large versions.
    if (bytes >= MIB) {
      ctx.withTx((tx: any) => {
        const row = { key, until: new Timestamp(tx.timestamp.microsSinceUnixEpoch + BigInt(Math.ceil((bytes / MIB) * 1e6))) };
        if (tx.db.versionCooldown.key.find(key)) tx.db.versionCooldown.key.update(row); else tx.db.versionCooldown.insert(row);
      });
    }
    return result;
  }

  return {
    /**
     * Save, step 1: one transaction reads the board, checks the bundle restores, and records a
     * pending index row with its own object key. Returns the row and the bundle (charged).
     * A procedure, as a reducer cannot return the bundle.
     */
    captureBoardVersion: db.procedure({ boardId: t.u64() }, t.string(), (ctx: any, { boardId }: any) => {
      const uuid = ctx.newUuidV7().toString();
      return charged(ctx, 'capture', (tx: any, read: (bytes: number) => void) => {
        human(tx);
        const board = tx.db.board.id.find(boardId), workspaceId = boardScope(tx, boardId);
        if (!board || workspaceId === undefined || roleRank(humanBoardRole(tx, boardId)) < 2) fail('saving a version needs edit access to a workspace board');
        if (!pluginEnabled(tx, workspaceId, 'versions')) fail(OFF);
        const version = tx.db.architectureVersion.boardId.find(boardId);
        const history = version && tx.db.architectureHistory.id.find(version.historyId);
        const text = bundleText(captureBoard(tx, boardId, { workspaceId, architecture: version && { ...version, repository: history?.repository ?? '' } }));
        const bytes = new TextEncoder().encode(text);
        read(bytes.length);
        if (bytes.length > MAX_BUNDLE_BYTES) fail(`this board is ${(bytes.length / 1048576).toFixed(1)} MiB as a saved version; a version holds at most ${MAX_BUNDLE_BYTES / 1048576} MiB`);
        // Refuse now what a restore would refuse later (an inconsistent board), not after storing it.
        try { parseBundle(text); } catch (e) { if (e instanceof BundleError) fail(`this board cannot be saved: ${e.message}`); throw e; }
        // The uuid's randomness comes from the timestamp: a second capture in the same microsecond gets a suffix.
        let objectKey = `versions/w${workspaceId}/b${boardId}/${uuid}`;
        for (let n = 1; tx.db.boardVersion.objectKey.find(`${objectKey}.json`); n++) objectKey = `versions/w${workspaceId}/b${boardId}/${uuid}-${n}`;
        const row = tx.db.boardVersion.insert({
          id: 0n, workspaceId, boardId, boardName: board.name, objectKey: `${objectKey}.json`, sha256: sha256Bytes(bytes),
          bytes: BigInt(bytes.length), formatVersion: BUNDLE_VERSION, status: 'pending', createdBy: tx.sender, createdAt: tx.timestamp,
        });
        return { versionId: row.id.toString(), objectKey: row.objectKey, sha256: row.sha256, bytes: bytes.length, bundle: text };
      });
    }),

    // Save, step 2: only the server that holds the storage credentials lists a version, after storing it.
    publishBoardVersion: db.reducer({ versionId: t.u64(), sha256: t.string() }, (ctx: any, { versionId, sha256 }: any) => {
      hooks.assertService(ctx);
      const s = ctx.db.boardVersion.id.find(versionId);
      if (!s || s.sha256 !== sha256) fail('this version is unavailable');
      if (s.status === 'ready') return;
      if (!pluginEnabled(ctx, s.workspaceId, 'versions')) fail(OFF);
      if (boardScope(ctx, s.boardId) !== s.workspaceId || roleRank(humanBoardRole(ctx, s.boardId, s.createdBy)) < 2) fail('the person saving this version lost edit access before it was stored');
      ctx.db.boardVersion.id.update({ ...s, status: 'ready' });
    }),

    // Restore, step 1 of n: the stored bundle, one piece at a time. Index 0 drops the caller's earlier pieces.
    stageBoardVersionChunk: reducer({ versionId: t.u64(), requestKey: t.string(), index: t.u32(), data: t.string() }, (ctx: any, { versionId, requestKey, index, data }: any) => {
      const s = restorable(ctx, versionId);
      const same = (c: any) => c.versionId === versionId && c.requestKey === requestKey;
      const mine = [...ctx.db.boardVersionChunk.owner.filter(ctx.sender)];
      if (index === 0) for (const c of mine.filter(same)) ctx.db.boardVersionChunk.id.delete(c.id);
      const staged = index === 0 ? [] : mine.filter(same);
      if (staged.length !== index) fail(`expected piece ${staged.length} of this restore, not ${index}; start again from piece 0`);
      // UTF-16 units never outnumber UTF-8 bytes, so this bounds the staged text by the stored size.
      const total = staged.reduce((n: number, c: any) => n + c.data.length, data.length);
      if (total > Number(s.bytes)) fail('the staged bundle is larger than the stored version');
      // The person's other restores (another tab) keep their pieces, up to two bundles in all; the oldest pieces go first.
      let kept = total;
      for (const c of mine.filter((c: any) => !same(c)).sort((a: any, b: any) => (a.id < b.id ? 1 : -1))) {
        kept += c.data.length;
        if (kept > 2 * MAX_BUNDLE_BYTES) ctx.db.boardVersionChunk.id.delete(c.id);
      }
      ctx.db.boardVersionChunk.insert({ id: 0n, owner: ctx.sender, versionId, requestKey, index, data });
    }),

    // Restore, last step: one transaction checks the staged bundle against the index and builds a new
    // private board. Returns { boardId } (charged; a procedure so that a refusal still spends its write).
    restoreBoardVersion: db.procedure({ versionId: t.u64(), requestKey: t.string(), name: t.string() }, t.string(), (ctx: any, { versionId, requestKey, name }: any) => charged(ctx, 'restore', (tx: any, read: (bytes: number) => void) => {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(requestKey)) fail('the restore request key must contain 32–128 URL-safe characters');
      if (name.trim()) hooks.assertBoardName(name.trim()); // before the hashing and parsing below
      const receipt = tx.db.boardCreation.requestKey.find(requestKey);
      if (receipt) {
        if (!receipt.owner.isEqual(tx.sender)) fail('this restore request key belongs to someone else');
        return { boardId: receipt.boardId.toString() }; // a retried restore that already finished
      }
      const s = restorable(tx, versionId);
      const chunks = [...tx.db.boardVersionChunk.owner.filter(tx.sender)].filter((c: any) => c.versionId === versionId && c.requestKey === requestKey).sort((a: any, b: any) => a.index - b.index);
      for (const c of chunks) tx.db.boardVersionChunk.id.delete(c.id);
      const text = chunks.map((c: any) => c.data).join('');
      const bytes = new TextEncoder().encode(text);
      read(bytes.length);
      if (BigInt(bytes.length) !== s.bytes || sha256Bytes(bytes) !== s.sha256) fail('the bundle does not match the stored version; it may be corrupt or incomplete');
      let bundle;
      try {
        bundle = parseBundle(text, { time: m => new Timestamp(m), identity: h => Identity.fromString(h) });
      } catch (e) {
        if (e instanceof BundleError) fail(`this version cannot be restored: ${e.message}`);
        throw e;
      }
      const title = (name.trim() || `${bundle.name} (restored)`.slice(0, 100)).trim();
      hooks.assertBoardName(title);
      const board = hooks.insertBoard(tx, title);
      hooks.initCallerBoard(tx, board.id, title, 'version');
      restoreBoard(tx, bundle, board.id, Timestamp.UNIX_EPOCH);
      // Private: the restorer manages it, the workspace default is none, and no old grant, link or embed returns.
      assignBoardWorkspace(tx, board.id, s.workspaceId, tx.sender);
      hooks.refreshStats(tx, board.id);
      tx.db.boardCreation.insert({ requestKey, owner: tx.sender, boardId: board.id });
      hooks.emit(tx, board.id, 'board.restored', { versionId: versionId.toString(), from: s.boardId.toString() });
      return { boardId: board.id.toString() };
    })),

    // Ready versions the caller may list: readers of the board, and workspace owners and admins.
    myBoardVersions: db.view({ name: 'my_board_versions', public: true }, t.array(Version), (ctx: any) => {
      if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
      return [...ctx.db.workspaceMember.member.filter(ctx.sender)].flatMap((m: any) => {
        if (!pluginEnabled(ctx, m.workspaceId, 'versions')) return [];
        return [...ctx.db.boardVersion.workspaceId.filter(m.workspaceId)].filter((s: any) => s.status === 'ready' && mayUse(ctx, s, 1)).map((s: any) => ({
          id: s.id, workspaceId: s.workspaceId, boardId: s.boardId, boardName: s.boardName, objectKey: s.objectKey, sha256: s.sha256, bytes: s.bytes,
          formatVersion: s.formatVersion, createdBy: s.createdBy, creatorName: ctx.db.participant.identity.find(s.createdBy)?.displayName ?? '', createdAt: s.createdAt,
        }));
      });
    }),
  };
}
