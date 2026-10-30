/**
 * Test support for @bugcapsule/emergency-guard: a throwaway P-256 signing
 * key, an anchor in the documented format, documents signed with
 * node:crypto, and a node:http fake of the BugCapsule policy API.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const APP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const ENV = 'production';
export const INGEST_KEY = 'bct_TestOnlyIngestKeyForEmergencyGuard01';
export const T0 = Date.parse('2026-10-29T08:30:00.000Z');

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../spec-fixtures/emergency-v1/${name}`, import.meta.url), 'utf8')) as T;
}

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  spki: string;
}

export function makeKey(kid = `ek_${randomBytes(6).toString('base64url')}`): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
}

export function makeAnchor(app: string, keys: { kid: string; spki: string; alg?: string }[]): string {
  const body = { app, keys: keys.map((k) => ({ kid: k.kid, alg: k.alg ?? 'ES256', spki: k.spki })) };
  return `bcek.v1.${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
}

export function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_id: 'p-1',
    key: 'checkout.confirm_order',
    revision: 1,
    action: 'BLOCK',
    priority: 0,
    severity: 'P0',
    incident_id: 'inc-1',
    target_platforms: [],
    version_ranges: [],
    rollout_bp: 10000,
    rollout_seed: 'seed-1',
    reason_code: 'PRICING_SAFETY',
    public_user_message: 'Checkout is temporarily unavailable.',
    required_version: null,
    fallback: null,
    expires_at: null,
    ...overrides,
  };
}

export function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'bugcapsule.emergency.policy-document',
    schema_version: 1,
    application_id: APP_ID,
    environment: ENV,
    revision: 1,
    issued_at: new Date(T0 - 60_000).toISOString(),
    expires_at: new Date(T0 + 3600_000).toISOString(),
    policies: [],
    ...overrides,
  };
}

export interface Envelope {
  format: string;
  alg: string;
  kid: string;
  payload: string;
  signature: string;
}

/** Signs the exact bytes of `payload` (an object is JSON-serialized first). */
export function signEnvelope(key: TestKey, payload: unknown, overrides: Partial<Envelope> = {}): Envelope {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const signature = sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'der' });
  return { format: 'bugcapsule.emergency.v1', alg: 'ES256', kid: key.kid, payload: bytes.toString('base64url'), signature: signature.toString('base64url'), ...overrides };
}

export function etagOf(envelope: Envelope): string {
  return `"${createHash('sha256').update(envelope.payload).digest('hex').slice(0, 32)}"`;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

/** What the fake answers for the next GET; `null` falls back to serving `envelope`. */
export type Override = { status: number; body?: string; headers?: Record<string, string>; delayMs?: number } | { hang: true };

/**
 * A node:http fake of the BugCapsule emergency endpoints. Serves the
 * current envelope with an ETag and answers If-None-Match with 304; records
 * every request and receipt.
 */
export class FakeBugCapsule {
  envelope: Envelope | null = null;
  delayMs = 0;
  readonly overrides: Override[] = [];
  /** Applied to every GET while set (after one-shot overrides). */
  sticky: Override | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly receipts: Record<string, unknown>[] = [];
  private server: Server | null = null;
  private readonly hanging = new Set<ServerResponse>();
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  get policyGets(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/emergency/policies'));
  }

  serve(envelope: Envelope): void {
    this.envelope = envelope;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', 'http://x');
    const rec: RecordedRequest = { method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    this.requests.push(rec);
    if (req.headers.authorization !== `Bearer ${INGEST_KEY}`) return this.send(res, 401, JSON.stringify({ title: 'Unauthorized' }));
    if (req.method === 'POST' && u.pathname === `/v1/apps/${APP_ID}/emergency/receipts`) {
      this.receipts.push(JSON.parse(rec.body) as Record<string, unknown>);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET' || u.pathname !== `/v1/apps/${APP_ID}/emergency/policies`) return this.send(res, 404, '{}');
    const o = this.overrides.shift() ?? this.sticky;
    if (o && 'hang' in o) {
      this.hanging.add(res);
      return;
    }
    const delay = o?.delayMs ?? this.delayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (o) return this.send(res, o.status, o.body ?? '', o.headers);
    if (!this.envelope) return this.send(res, 409, JSON.stringify({ title: 'Integration Not Configured', status: 409, reason: 'emergency_not_configured' }));
    const etag = etagOf(this.envelope);
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim() === etag)) {
      res.writeHead(304, { etag }).end();
      return;
    }
    this.send(res, 200, JSON.stringify(this.envelope), { etag, 'content-type': 'application/json' });
  }

  private send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until `fn` is truthy or the timeout passes. */
export async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await delay(5);
  }
}

export interface CapturedLogger {
  lines: string[];
  debug(m: string, meta?: unknown): void;
  info(m: string, meta?: unknown): void;
  warn(m: string, meta?: unknown): void;
  error(m: string, meta?: unknown): void;
}

export function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const push = (level: string) => (m: string, meta?: unknown) => {
    lines.push(`${level} ${m}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`);
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}
