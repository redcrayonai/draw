/** A session's seat: the 16-character name an agent claims review marks under (module SEAT_RE). */
export function newSeat(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 256 is not a multiple of 62: drop bytes >= 248 so every character is equally likely
  const out: string[] = [];
  while (out.length < 16) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 248 && out.length < 16) out.push(alphabet[b % 62]);
  return out.join('');
}

/** Marks that share any path form one group (a file is fixed by one agent at a time); no paths = a group of one. Groups and members by ascending id. */
export function groupByFiles(marks: { id: bigint; paths: string[] }[]): bigint[][] {
  const sorted = [...marks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups: { ids: bigint[]; paths: Set<string> }[] = [];
  for (const m of sorted) {
    const hit = groups.filter(g => m.paths.some(p => g.paths.has(p)));
    const into = hit[0] ?? (groups.push({ ids: [], paths: new Set() }), groups[groups.length - 1]);
    for (const g of hit.slice(1)) {
      into.ids.push(...g.ids);
      g.paths.forEach(p => into.paths.add(p));
      groups.splice(groups.indexOf(g), 1);
    }
    into.ids.push(m.id);
    m.paths.forEach(p => into.paths.add(p));
  }
  return groups.map(g => g.ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
