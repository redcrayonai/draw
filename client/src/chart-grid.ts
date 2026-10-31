import { parseCsv } from '../../module/src/chart-contracts';

/**
 * The inspector grid's model: the stored CSV as rows of cells, header first.
 * Reads go through parseCsv, so the grid splits cells exactly as the server
 * does (tab or comma, RFC 4180 quotes). Writes are always comma CSV.
 */

/** Rows of cells with the header row first; [] when the text does not parse.
 *  The arrays are fresh, so the caller may edit them in place. */
export function csvToGrid(csv: string): string[][] {
  const r = parseCsv(csv);
  return r.ok ? [r.header.slice(), ...r.rows.map(row => row.slice())] : [];
}

// A cell is quoted when it holds a delimiter, a quote or a line break, or
// when leading or trailing space would be lost.
const NEEDS_QUOTES = /[",\t\r\n]|^\s|\s$/;

/** Comma CSV with RFC 4180 quoting and '\n' line ends, no trailing newline. */
export function gridToCsv(grid: string[][]): string {
  return grid
    .map(row => row.map(cell => (NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\n');
}
