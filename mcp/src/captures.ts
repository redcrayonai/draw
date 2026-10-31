/**
 * Captures on the hosted path (spec §5): `POST /facts` stores the helper's
 * upload under a fresh id, write-only (there is no GET), and a tool call
 * claims it once, within 10 minutes. The store is one CAPTURE Durable Object
 * per id; this file holds its logic, runtime-free, and the claim the tools run.
 */
import { CAPTURE_ID_RE, claimCapture, newCaptureId, type ClaimCall, type ClaimedCapture } from '../../shared/capture';
import { Refusal } from './scrub';

export const CAPTURE_TTL_MS = 10 * 60_000;
// Production documents 2 MB per stored value (Phase 0 P0.8); chunks stay well under it.
export const CHUNK_CHARS = 512 * 1024;

/** The Durable Object's storage, as the vault needs it: synchronous, so a claim cannot interleave (P0.8). */
export interface ChunkStore {
  write(chunks: string[], created: number): void;
  /** the chunks and their upload time, deleted in the same step; undefined when there is nothing (claimed, expired, never stored) */
  take(): { chunks: string[]; created: number } | undefined;
}

/** One capture's store: put once, take once, gone after 10 minutes either way. */
export class CaptureVault {
  constructor(private readonly store: ChunkStore, private readonly now: () => number = Date.now) {}

  put(text: string): void {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + CHUNK_CHARS, text.length);
      // never split a surrogate pair: half of one would be stored as U+FFFD
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
      chunks.push(text.slice(i, end));
      i = end;
    }
    this.store.write(chunks, this.now());
  }

  take(): string | undefined {
    const got = this.store.take();
    if (!got || this.now() - got.created > CAPTURE_TTL_MS) return undefined;
    return got.chunks.join('');
  }
}

export interface CaptureStub {
  put(text: string): Promise<void>;
  take(): Promise<string | undefined>;
}

export const FACTS_TOO_LARGE = 'Request too large: 8 MB maximum.';

const enc = new TextEncoder();

// AES-GCM 256 under HKDF-SHA256 of the capture id: the key is derived on use and kept nowhere (RC-690 Decision 5).
const captureKey = async (id: string) =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('redcrayon capture v1') },
    await crypto.subtle.importKey('raw', enc.encode(id), 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

/**
 * base64 of a 12-byte IV followed by the AES-GCM ciphertext of `text`; the store never holds the upload as sent.
 * Buffer encodes straight from the ciphertext. A JS loop over String.fromCharCode(...) made a binary string and an
 * 8-byte spread array per byte: an 8 MB upload peaked at 122 MB RSS (now 68 MB) and took 137 ms (now 17 ms).
 * 12 bytes is a multiple of 3, so the IV's base64 joins the ciphertext's without padding between them
 * and the ciphertext is never copied next to the IV.
 */
export async function sealCapture(id: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await captureKey(id), enc.encode(text));
  return Buffer.from(iv).toString('base64') + Buffer.from(sealed).toString('base64');
}

/** The text `sealCapture` sealed for `id`; undefined for any other input (another id, tampering, a body stored unsealed). */
export async function openCapture(id: string, sealed: string): Promise<string | undefined> {
  try {
    // Buffer skips characters that are not base64 instead of throwing; what it makes of them fails the GCM tag.
    const bytes = Buffer.from(sealed, 'base64');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await captureKey(id), bytes.subarray(12)));
  } catch {
    return undefined;
  }
}

const CAPTURE_KIND = /"kind"\s*:\s*"(?:start|ref|cite|checkpoint)"/;

/**
 * The upload, sealed and stored once it has a capture's outline: a JSON object
 * naming a capture kind. It is not parsed here, since a crafted 8 MB body
 * parses to many times its size with no sign-in. The claim parses it and runs every §5 check.
 * shortcut: the outline is matched, not parsed, so a body that only mimics it is stored (within FACTS_RL and the 10-minute TTL); move to a streaming parse if that is abused.
 */
export async function storeUpload(body: string, store: (id: string) => CaptureStub): Promise<{ status: number; json: unknown }> {
  const text = body.trim();
  if (!text.startsWith('{') || !text.endsWith('}') || !CAPTURE_KIND.test(text)) return { status: 400, json: { error: 'invalid_capture' } };
  const id = newCaptureId();
  await store(id).put(await sealCapture(id, body));
  return { status: 200, json: { capture: id } };
}

export const captureGone = (id: string) =>
  `REJECTED: capture ${id} expired or was already used (a capture works once, within 10 minutes). Nothing was written. Run the capture again and pass the new id.`;

/** Claim `id` for `call`: taken from the store (once), then every §5 check. Throws the REJECTED text on any failure. */
export async function claim(store: (id: string) => CaptureStub, id: string, call: ClaimCall): Promise<ClaimedCapture> {
  if (!CAPTURE_ID_RE.test(id)) throw new Refusal(captureGone(id));
  const sealed = await store(id).take();
  // a body stored unsealed (before this release) opens as undefined: gone
  const text = sealed === undefined ? undefined : await openCapture(id, sealed);
  if (text === undefined) throw new Refusal(captureGone(id));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined; // claimCapture refuses it as not an object
  }
  const claimed = await claimCapture(id, body, call);
  if (!claimed.ok) throw new Refusal(claimed.text);
  return claimed.capture;
}

const SOURCE = /^source:(.+):(\d+)$/;

/** Every file the board's refs and source: edges need, for the helper's cited/<board> (spec §5 Local state). */
export function citedPaths(refs: { path: string }[], edges: { evidence: string }[]): string[] {
  const paths = new Set(refs.map(r => r.path));
  for (const e of edges) {
    const m = SOURCE.exec(e.evidence);
    if (m) paths.add(m[1]);
  }
  return [...paths].sort();
}
