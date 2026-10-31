/**
 * What a board keeps of a line of code when it keeps no text (RC-690): the
 * SHA-256 of the line's UTF-8 text, lowercase hex, first 32 characters. A code
 * ref stores its lines' hashes space-joined, in range order. One definition,
 * shared by the flows and the one-time wipe script.
 */
import { createHash } from 'node:crypto';

export const lineHash = (line: string): string => createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 32);

export const lineHashes = (lines: string[]): string[] => lines.map(lineHash);
