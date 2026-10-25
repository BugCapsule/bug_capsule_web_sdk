import type { BugCapsuleBackendConfig } from './types.js';

/**
 * SDK connection token v1: `bcsdk.v1.<base64url JSON {api, key}>`. One
 * string from the dashboard carries the API URL and the ingest-only
 * credential; the backend derives the project from the credential. The
 * token is client-visible and grants uploads only. Test vectors:
 * spec-fixtures/connection-token-v1/vectors.json.
 */
export type ConnectionTokenError = 'invalid_token' | 'unsupported_token_version';

export type ParsedConnectionToken =
  | { ok: true; backend: BugCapsuleBackendConfig }
  | { ok: false; error: ConnectionTokenError; message: string };

const SUPPORTED_VERSION = 1;
const KEY = /^(bct|bci)_[A-Za-z0-9_-]{16,200}$/;

function decodeBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  try {
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function apiUrl(api: unknown): string | null {
  if (typeof api !== 'string' || api.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null;
  return api.replace(/\/+$/, '');
}

/** Parses a connection token offline. Never throws. */
export function parseConnectionToken(raw: string): ParsedConnectionToken {
  const bad = (message: string): ParsedConnectionToken => ({ ok: false, error: 'invalid_token', message });
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return bad('the token is empty; copy it from the BugCapsule dashboard (Project settings → Keys → SDK tokens)');
  if (/^(bci|bct)_/.test(token)) return bad('this is an ingest key, not a connection token: pass it as backend: { url, ingestKey }, or generate an SDK token in the dashboard');
  if (token.startsWith('bcs_')) return bad('this is a secret key: never ship it in an app. Rotate it and generate an SDK token in the dashboard');
  const m = /^bcsdk\.v(\d+)\.(.*)$/s.exec(token);
  if (!m) return bad('a connection token starts with "bcsdk.v1."; copy the whole token from the dashboard');
  if (Number(m[1]) !== SUPPORTED_VERSION) {
    return { ok: false, error: 'unsupported_token_version', message: `token version ${m[1]} needs a newer @bugcapsule/web (this one understands v${SUPPORTED_VERSION})` };
  }
  const json = decodeBase64Url(m[2]!);
  if (json === null) return bad('the token is damaged or incomplete; copy it again from the dashboard');
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return bad('the token is damaged or incomplete; copy it again from the dashboard');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return bad('the token is damaged; copy it again from the dashboard');
  const { api, key } = payload as { api?: unknown; key?: unknown };
  if (typeof key !== 'string' || !KEY.test(key)) return bad('the token has no valid ingest credential; generate a new token');
  const url = apiUrl(api);
  if (!url) return bad('the token has no valid API URL; generate a new token');
  return { ok: true, backend: { url, ingestKey: key } };
}
