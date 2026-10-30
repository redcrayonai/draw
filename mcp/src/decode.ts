/**
 * /sql rows decoded by their schema into what the tools read: camelCase keys,
 * u64 and i64 as bigint, arrays element by element, an option as its value or
 * undefined ([0, v] or [1, []] on the wire), a timestamp as
 * { microsSinceUnixEpoch }, an identity as lowercase hex.
 */
import type { DbType } from '../../shared/db-http';

const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

type Element = { name: { some?: string }; algebraic_type: DbType };

export function decodeCell(type: DbType, value: unknown): unknown {
  if ('U64' in type || 'I64' in type || 'U128' in type || 'I128' in type) return BigInt(value as number | bigint);
  if ('Array' in type) return (value as unknown[]).map(v => decodeCell(type.Array as DbType, v));
  if ('Sum' in type) {
    const variants = (type.Sum as { variants: Element[] }).variants;
    const [tag, inner] = value as [number, unknown];
    if (variants.length === 2 && variants[0].name.some === 'some' && variants[1].name.some === 'none') {
      return tag === 0 ? decodeCell(variants[0].algebraic_type, inner) : undefined;
    }
    return { tag: variants[tag]?.name.some, value: inner };
  }
  if ('Product' in type) {
    const elements = (type.Product as { elements: Element[] }).elements;
    const cells = value as unknown[];
    const first = elements[0]?.name.some;
    if (elements.length === 1 && first === '__timestamp_micros_since_unix_epoch__') return { microsSinceUnixEpoch: BigInt(cells[0] as number) };
    if (elements.length === 1 && first === '__identity__') return String(cells[0]).replace(/^0x/, '').toLowerCase();
    return Object.fromEntries(elements.map((e, i) => [camel(e.name.some ?? String(i)), decodeCell(e.algebraic_type, cells[i])]));
  }
  return value;
}

export function decodeRows(result: { columns: { name: string; type: DbType }[]; rows: unknown[][] }): Record<string, unknown>[] {
  return result.rows.map(row => Object.fromEntries(result.columns.map((c, i) => [camel(c.name), decodeCell(c.type, row[i])])));
}
