/**
 * The credential the guard fetches with: a project SDK token / ingest key
 * (`bct_…`, legacy `bci_…`) plus the API URL, or a whole connection token
 * (`bcsdk.v1.<base64url {api, key}>`) that carries both. Secret keys
 * (`bcs_…`) are refused: the policy endpoint never needs them.
 */
import { decodeBase64Url } from './verify.js';

const KEY_RE = /^(bct|bci)_[A-Za-z0-9_-]{16,200}$/;

export interface ResolvedCredential {
  apiUrl: string;
  key: string;
}

export class InvalidCredentialError extends TypeError {
  override readonly name = 'InvalidCredentialError';
}

function normalizeApiUrl(api: unknown): string | null {
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

/** Resolves the credential and API URL. Throws InvalidCredentialError; messages never contain the credential. */
export function resolveCredential(credential: string, apiUrl: string | undefined): ResolvedCredential {
  const bad = (message: string): never => {
    throw new InvalidCredentialError(message);
  };
  const c = typeof credential === 'string' ? credential.trim() : '';
  if (!c) return bad('credential is required: an SDK token (bcsdk.v1…) or an ingest key (bct_…)');
  if (c.startsWith('bcs_')) return bad('credential is a secret key; use an SDK token (bcsdk.v1…) or an ingest key (bct_…) instead');
  let key: string;
  let tokenApi: string | null = null;
  const m = /^bcsdk\.v(\d+)\.(.*)$/s.exec(c);
  if (m) {
    if (m[1] !== '1') return bad(`connection token version ${m[1]} is not supported by this @bugcapsule/emergency-guard (it understands v1)`);
    const raw = decodeBase64Url(m[2]!);
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) : null;
    } catch {
      payload = null;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return bad('the connection token is damaged; copy it again from the dashboard');
    const p = payload as { api?: unknown; key?: unknown };
    if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) return bad('the connection token has no valid ingest credential; generate a new token');
    tokenApi = normalizeApiUrl(p.api);
    if (!tokenApi) return bad('the connection token has no valid API URL; generate a new token');
    key = p.key;
  } else if (KEY_RE.test(c)) {
    key = c;
  } else {
    return bad('credential must be an SDK token (bcsdk.v1…) or an ingest key (bct_…)');
  }
  let api = tokenApi;
  if (apiUrl !== undefined) {
    api = normalizeApiUrl(apiUrl);
    if (!api) return bad('apiUrl must be an http(s) URL without credentials, query or fragment');
  }
  if (!api) return bad('apiUrl is required when the credential is an ingest key');
  return { apiUrl: api, key };
}
