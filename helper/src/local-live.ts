import { readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { localLines } from './local-lines';
import { localCall, localEndpoint } from './local-mcp';
import { LOCAL_ACTIVITY_LIMITS as LIMITS, localInteraction, type LocalInteraction } from '../../shared/local-activity';

export async function runLocalLive(args: string[]) {
  const flags = new Map<string, string>();
  const endpointArgs: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--store', '--board', '--map'].includes(args[i]) || !args[i + 1]) throw new Error('REJECTED: usage: redcrayon live --board slug --map mapping.json [--repo path] [--store path]');
    flags.set(args[i], args[i + 1]); if (['--repo', '--store'].includes(args[i])) endpointArgs.push(args[i], args[i + 1]);
  }
  if (!flags.has('--board') || !flags.has('--map')) throw new Error('REJECTED: --board and --map are required');
  if (statSync(flags.get('--map')!).size > 1024 * 1024) throw new Error('REJECTED: mapping file exceeds 1 MB');
  const mappingFile = readFileSync(flags.get('--map')!);
  const mapping = JSON.parse(mappingFile.toString('utf8'));
  const endpoint = localEndpoint(endpointArgs), board = flags.get('--board');
  let batch: LocalInteraction[] = [], accepted = 0, rejected = 0;
  let failure: Error | undefined;
  let warnings: Record<string, number> = {};
  const warn = (message: string) => { rejected++; warnings[message] = (warnings[message] ?? 0) + 1; };
  const report = async (message: string) => { if (!process.stderr.write(`${message}\n`)) await once(process.stderr, 'drain'); };
  let sending = Promise.resolve();
  const flush = (final = false) => {
    const events = batch; batch = [];
    const notices = warnings; warnings = {};
    sending = sending.then(async () => {
      if (failure) return;
      try {
        const result = await localCall(endpoint, { action: 'activity', board, mapping, events, flush: final });
        accepted += result.accepted;
        for (const [reason, count] of Object.entries(result.rejected) as [string, number][]) { rejected += count; await report(`Dropped ${count}: ${reason}`); }
        for (const [reason, count] of Object.entries(notices)) await report(`Dropped ${count}: ${reason}`);
      } catch (error) { failure = error instanceof Error ? error : new Error('UNAVAILABLE: activity disconnected'); }
    });
    return sending;
  };
  // At most one periodic request plus one 250-event batch; stdin pauses while delivery catches up.
  let timerPending = false;
  const timer = setInterval(() => {
    if (!timerPending && (batch.length || Object.keys(warnings).length) && !failure) { timerPending = true; void flush().finally(() => { timerPending = false; }); }
  }, 1000);
  try {
    for await (const line of localLines(process.stdin, LIMITS.lineBytes, warn)) {
      if (failure) throw failure;
      try { batch.push(localInteraction(JSON.parse(line))); }
      catch (error) { warn(error instanceof SyntaxError ? 'REJECTED: malformed JSON' : (error as Error).message); }
      if (batch.length >= LIMITS.batch) await flush();
    }
    await flush(true);
    if (failure) throw failure;
    await report(`Accepted ${accepted}; rejected ${rejected}.`);
    return rejected ? 1 : 0;
  } finally { clearInterval(timer); }
}
