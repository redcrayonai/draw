// An S3-compatible object store over fetch and WebCrypto (Signature Version 4), for plugins that
// keep files outside the database. The operator supplies the endpoint, bucket and region, and keys
// or a machine role; credentials stay on this server. Only what Versions needs: put once, get, head.
// shortcut: path-style URLs only (<endpoint>/<bucket>/<key>), which MinIO, Garage, Ceph, R2 and
// S3 accept; add virtual-hosted URLs when a store refuses path style.

export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface StoreConfig extends Credentials { endpoint: string; bucket: string; region: string }

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (data: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
const hmac = async (key: Uint8Array | ArrayBuffer, text: string) =>
  crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(text));
const encodeKey = (key: string) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/** The signed request, for tests and for objectRequest. `now` is the signing time. */
export async function signedRequest(config: StoreConfig, method: string, key: string, init: { body?: Uint8Array; headers?: Record<string, string>; now?: Date } = {}) {
  const url = new URL(`${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`);
  const amzDate = (init.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payload = await sha256Hex(init.body ?? new Uint8Array());
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken; // a role's temporary credentials
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, url.search.slice(1), names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
  const scope = `${day}/${config.region}/s3/aws4_request`;
  let k = await hmac(enc.encode(`AWS4${config.secretAccessKey}`), day);
  for (const part of [config.region, 's3', 'aws4_request']) k = await hmac(k, part);
  const signature = hex(await hmac(k, ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n')));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete headers.host; // fetch sends it from the URL
  return { url, headers };
}

async function objectRequest(config: StoreConfig, method: string, key: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
  const { url, headers } = await signedRequest(config, method, key, init);
  return fetch(url, { method, headers, body: init.body, signal: AbortSignal.timeout(60_000) });
}

export class StoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

let role: { creds: Credentials; until: number } | undefined;

/**
 * The machine's role credentials, for a server given no keys: the container credentials endpoint when
 * its variables are set (an ECS task role), else the instance metadata service, IMDSv2 (an EC2 instance
 * profile). Kept until five minutes before they expire.
 * shortcut: no web identity token files (EKS IRSA, Pod Identity), which a Worker cannot read; give those deployments keys.
 */
export async function machineCredentials(vars: Record<string, string | undefined>, now = Date.now()): Promise<Credentials> {
  if (role && role.until > now) return role.creds;
  const get = async (url: string, init: RequestInit = {}) => {
    // Nothing answering is a setup without keys or a role, not an outage: no retry, and the log says which.
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) }).catch(() => {
      throw new StoreError(401, 'no machine role answered: set both VERSIONS_S3 keys, or run where a role is attached');
    });
    if (!r.ok) { await r.body?.cancel(); throw new StoreError(r.status, `the machine's credentials endpoint answered ${r.status}`); }
    return r;
  };
  const container = vars.AWS_CONTAINER_CREDENTIALS_FULL_URI || (vars.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && `http://169.254.170.2${vars.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`);
  let body;
  if (container) {
    body = await (await get(container, vars.AWS_CONTAINER_AUTHORIZATION_TOKEN ? { headers: { authorization: vars.AWS_CONTAINER_AUTHORIZATION_TOKEN } } : {})).json();
  } else {
    const imds = 'http://169.254.169.254/latest';
    const headers = { 'x-aws-ec2-metadata-token': await (await get(`${imds}/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } })).text() };
    const name = (await (await get(`${imds}/meta-data/iam/security-credentials/`, { headers })).text()).split('\n')[0].trim();
    body = await (await get(`${imds}/meta-data/iam/security-credentials/${encodeURIComponent(name)}`, { headers })).json();
  }
  if (!body?.AccessKeyId || !body.SecretAccessKey) throw new StoreError(401, 'the machine has no role credentials');
  const creds = { accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, sessionToken: body.Token || undefined };
  const expires = Date.parse(body.Expiration);
  role = { creds, until: (Number.isFinite(expires) ? expires : now + 3_600_000) - 300_000 };
  return creds;
}

/**
 * Writes `body` at `key` only if nothing is there (If-None-Match: *), so no write replaces an object.
 * 'exists' when the key is taken. The store checks the body against its signed SHA-256.
 */
export async function putNew(config: StoreConfig, key: string, body: Uint8Array): Promise<'stored' | 'exists'> {
  const r = await objectRequest(config, 'PUT', key, { body, headers: { 'if-none-match': '*', 'content-type': 'application/json' } });
  await r.body?.cancel();
  if (r.ok) return 'stored';
  // 409: a store that refuses a concurrent conditional write to the same key
  if (r.status === 412 || r.status === 409) return 'exists';
  throw new StoreError(r.status, `the object store answered ${r.status} to a write`);
}

/** The object's bytes, refusing one longer than `maxBytes`; undefined when there is none. */
export async function getObject(config: StoreConfig, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
  const r = await objectRequest(config, 'GET', key);
  if (r.status === 404) { await r.body?.cancel(); return undefined; }
  if (!r.ok) { await r.body?.cancel(); throw new StoreError(r.status, `the object store answered ${r.status} to a read`); }
  if (Number(r.headers.get('content-length') ?? 0) > maxBytes) { await r.body?.cancel(); throw new StoreError(413, 'the stored object is larger than expected'); }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > maxBytes) throw new StoreError(413, 'the stored object is larger than expected');
  return bytes;
}
