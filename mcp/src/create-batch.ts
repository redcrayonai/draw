import { DbError } from '../../shared/db-http';
import { positional, type Database, type SafeU64 } from './db';
import { isTransport } from './scrub';

type Kind = 'create_node' | 'create_icon_node' | 'create_edge';
type Entry = { item: unknown[]; db: Database; signal: AbortSignal; resolve: (id: bigint) => void; reject: (error: unknown) => void };

/** One apply_board wave: policy refusals and duplicate answers also release the barrier. */
export class CreateBatch {
  private readonly ready = new Set<number>();
  private readonly pending: Entry[] = [];
  private readonly claims = new Set<string>();
  private readonly boards = new Map<string, Promise<{ id: SafeU64; name: string }>>();
  private flushed = false;
  constructor(private readonly size: number) {}

  board(id: string, read: () => Promise<{ id: SafeU64; name: string }>) {
    if (!this.boards.has(id)) this.boards.set(id, read());
    return this.boards.get(id)!;
  }

  claim(slot: number, key: string) {
    // A duplicate waits for its peer's ledger result, so it cannot hold up that peer's write.
    if (this.claims.has(key)) this.finish(slot);
    else this.claims.add(key);
  }

  finish(slot: number) {
    this.ready.add(slot);
    if (!this.flushed && this.ready.size === this.size) {
      this.flushed = true;
      void this.send(this.pending);
    }
  }

  submit(slot: number, key: string, kind: Kind, args: Record<string, unknown>, db: Database, signal: AbortSignal): Promise<bigint> {
    const values = positional(kind, args);
    if (kind === 'create_node') values.push({ none: [] }); // the batch node's optional icon
    if (kind === 'create_icon_node') values[values.length - 1] = { some: values[values.length - 1] };
    const item = [key, kind === 'create_edge' ? { none: [] } : { some: values }, kind === 'create_edge' ? { some: values } : { none: [] }];
    return new Promise((resolve, reject) => {
      const entry = { item, db, signal, resolve, reject };
      // A consent refusal can retry this item without text after its wave has settled.
      if (this.flushed) void this.send([entry]);
      else { this.pending.push(entry); this.finish(slot); }
    });
  }

  private async send(entries: Entry[]) {
    if (!entries.length) return;
    try {
      const run = () => entries[0].db.procedure<{ id?: bigint; error?: string; refused?: boolean }[]>(
        'create_board_items', [entries.map(e => e.item)], entries[0].signal
      );
      let results;
      try { results = await run(); }
      catch (e) {
        if (!isTransport(e) && !(e instanceof DbError && e.status >= 500 && e.status !== 530)) throw e;
        results = await run(); // the module's receipts make a lost response safe to retry
      }
      if (results.length !== entries.length) throw new DbError(502, 'incomplete batch response');
      results.forEach((r, i) => {
        if (r.id !== undefined) { entries[i].db.stats.writes++; entries[i].resolve(r.id); }
        else entries[i].reject(new DbError(r.refused ? 530 : 500, r.error ?? 'missing batch result'));
      });
    } catch (e) { entries.forEach(entry => entry.reject(e)); }
  }
}
