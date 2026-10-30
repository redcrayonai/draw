/**
 * OTLP/HTTP trace export bodies (JSON or protobuf) decoded into the few span
 * fields the tap keeps. Every attribute except the resource's service.name is
 * dropped here, at receipt: nothing else reaches the aggregator.
 */

export interface TapSpan {
  service: string;
  spanId: string;
  parentSpanId: string | null;
  /** Duration in ms. */
  ms: number;
  error: boolean;
}

/** Status code 2 is STATUS_CODE_ERROR in both encodings. */
const ERROR = 2;

const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** OTLP/JSON: ids are hex strings, times are decimal strings (or numbers), enums are numbers or names. */
export function decodeJson(body: unknown): TapSpan[] {
  const out: TapSpan[] = [];
  const rs = (body as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(rs)) return out;
  for (const r of rs) {
    const attrs = (r?.resource?.attributes ?? []) as Array<{ key?: string; value?: { stringValue?: string } }>;
    const service = attrs.find(a => a?.key === 'service.name')?.value?.stringValue ?? 'unknown';
    for (const ss of r?.scopeSpans ?? r?.instrumentationLibrarySpans ?? []) {
      for (const s of ss?.spans ?? []) {
        if (typeof s?.spanId !== 'string') continue;
        const start = BigInt(s.startTimeUnixNano ?? 0);
        const end = BigInt(s.endTimeUnixNano ?? 0);
        const code = s.status?.code;
        out.push({
          service,
          spanId: s.spanId.toLowerCase(),
          parentSpanId: typeof s.parentSpanId === 'string' && s.parentSpanId.length > 0 ? s.parentSpanId.toLowerCase() : null,
          ms: end > start ? Number(end - start) / 1e6 : 0,
          error: code === ERROR || code === 'STATUS_CODE_ERROR',
        });
      }
    }
  }
  return out;
}

/** A minimal protobuf reader: varints, fixed64 and length-delimited fields. */
class Reader {
  pos = 0;
  constructor(private b: Uint8Array, private end = b.length) {}
  done(): boolean {
    return this.pos >= this.end;
  }
  varint(): bigint {
    let shift = 0n;
    let v = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error('truncated varint');
      const byte = this.b[this.pos++];
      v |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return v;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }
  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new Error('truncated fixed64');
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.pos + i]);
    this.pos += 8;
    return v;
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new Error('truncated bytes');
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  /** Each field as [number, wire type]; unknown fields are skipped by the caller via skip(). */
  tag(): [number, number] {
    const t = Number(this.varint());
    return [t >>> 3, t & 7];
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function fields(b: Uint8Array, visit: (field: number, wire: number, r: Reader) => boolean): void {
  const r = new Reader(b);
  while (!r.done()) {
    const [field, wire] = r.tag();
    if (!visit(field, wire, r)) r.skip(wire);
  }
}

const utf8 = new TextDecoder();

function serviceOf(resource: Uint8Array): string {
  let service = 'unknown';
  fields(resource, (f, w, r) => {
    if (f !== 1 || w !== 2) return false; // attributes
    let key = '';
    let value = '';
    fields(r.bytes(), (kf, kw, kr) => {
      if (kf === 1 && kw === 2) { key = utf8.decode(kr.bytes()); return true; }
      if (kf === 2 && kw === 2) {
        fields(kr.bytes(), (vf, vw, vr) => {
          if (vf === 1 && vw === 2) { value = utf8.decode(vr.bytes()); return true; }
          return false;
        });
        return true;
      }
      return false;
    });
    if (key === 'service.name' && value) service = value;
    return true;
  });
  return service;
}

function span(b: Uint8Array, service: string): TapSpan | null {
  let spanId = '';
  let parent = '';
  let start = 0n;
  let end = 0n;
  let error = false;
  fields(b, (f, w, r) => {
    if (f === 2 && w === 2) { spanId = hex(r.bytes()); return true; }
    if (f === 4 && w === 2) { parent = hex(r.bytes()); return true; }
    if (f === 7 && w === 1) { start = r.fixed64(); return true; }
    if (f === 8 && w === 1) { end = r.fixed64(); return true; }
    if (f === 15 && w === 2) {
      fields(r.bytes(), (sf, sw, sr) => {
        if (sf === 3 && sw === 0) { error = Number(sr.varint()) === ERROR; return true; }
        return false;
      });
      return true;
    }
    return false; // name, kind, attributes, events, links: dropped
  });
  if (!spanId) return null;
  return { service, spanId, parentSpanId: parent || null, ms: end > start ? Number(end - start) / 1e6 : 0, error };
}

/** OTLP/protobuf ExportTraceServiceRequest. */
export function decodeProtobuf(body: Uint8Array): TapSpan[] {
  const out: TapSpan[] = [];
  fields(body, (f, w, r) => {
    if (f !== 1 || w !== 2) return false; // resource_spans
    const rs = r.bytes();
    let service = 'unknown';
    const scopes: Uint8Array[] = [];
    fields(rs, (rf, rw, rr) => {
      if (rf === 1 && rw === 2) { service = serviceOf(rr.bytes()); return true; }
      if (rf === 2 && rw === 2) { scopes.push(rr.bytes()); return true; }
      return false;
    });
    for (const scope of scopes) {
      fields(scope, (sf, sw, sr) => {
        if (sf !== 2 || sw !== 2) return false; // spans
        const s = span(sr.bytes(), service);
        if (s) out.push(s);
        return true;
      });
    }
    return true;
  });
  return out;
}
