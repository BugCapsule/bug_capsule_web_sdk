/**
 * Structural validation of a decoded capsule document (spec capsule-v1
 * "Validation", capsule-v2 §9 + runtimes-v1 §2). Same rules and messages as the Dart reader
 * (`capsule_validator.dart`) and the backend (`src/capsule.ts`); the shared
 * fixtures hold all three to it.
 */
export const CapsuleLimits = Object.freeze({
  maxEvents: 200_000,
  maxDepth: 100,
  maxLabels: 100,
  maxIntegrations: 100,
  maxMissing: 500,
  maxRedactionKeys: 500,
  maxCapabilities: 200,
  maxFrameworks: 20,
  maxDependencies: 100,
  maxDependencyItems: 100,
  maxTested: 20,
  maxJsonValues: 4_000_000,
});

type Obj = Record<string, unknown>;

class Invalid extends Error {}

function fail(path: string, reason: string): never {
  throw new Invalid(`${path} ${reason}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function object(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, 'must be an object');
  return v;
}

function optObject(o: Obj, key: string, path: string): Obj | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  return object(v, `${path}.${key}`);
}

function array(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  if (v.length > max) fail(path, `must have at most ${max} items`);
  return v;
}

function string(o: Obj, key: string, path: string, max = 1000, min = 1): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`${path}.${key}`, 'must be a string');
  if (v.length < min) fail(`${path}.${key}`, 'must not be empty');
  if (v.length > max) fail(`${path}.${key}`, `must be at most ${max} characters`);
  return v;
}

function optString(o: Obj, key: string, path: string, max = 1000): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(`${path}.${key}`, 'must be a string or null');
  if (v.length > max) fail(`${path}.${key}`, `must be at most ${max} characters`);
  return v;
}

function int(o: Obj, key: string, path: string, min?: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`${path}.${key}`, 'must be an integer');
  if (min !== undefined && v < min) fail(`${path}.${key}`, `must be >= ${min}`);
  return v;
}

function optInt(o: Obj, key: string, path: string, min?: number): number | null {
  if (o[key] === undefined || o[key] === null) return null;
  return int(o, key, path, min);
}

function optNum(o: Obj, key: string, path: string): void {
  const v = o[key];
  if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
    fail(`${path}.${key}`, 'must be a number or null');
  }
}

function optBool(o: Obj, key: string, path: string): void {
  const v = o[key];
  if (v !== undefined && v !== null && typeof v !== 'boolean') fail(`${path}.${key}`, 'must be a boolean or null');
}

function oneOf(o: Obj, key: string, path: string, values: readonly string[]): string {
  const v = o[key];
  if (typeof v !== 'string' || !values.includes(v)) fail(`${path}.${key}`, `must be one of ${values.join(', ')}`);
  return v;
}

const SENTRY_EVENT_ID = /^[0-9a-f]{32}$/;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

function isoDate(o: Obj, key: string, path: string): void {
  const v = o[key];
  const d = typeof v === 'string' && ISO_DATE_TIME.test(v) ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) fail(`${path}.${key}`, 'must be an ISO-8601 date-time with a time zone');
}

function stringMap(m: Obj, path: string, maxEntries = 1000, max = 10_000): void {
  const entries = Object.entries(m);
  if (entries.length > maxEntries) fail(path, `must have at most ${maxEntries} entries`);
  for (const [k, v] of entries) {
    if (typeof v !== 'string') fail(`${path}.${k}`, 'must be a string');
    if (v.length > max) fail(`${path}.${k}`, `must be at most ${max} characters`);
  }
}

function checkDepth(root: unknown): void {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (depth > CapsuleLimits.maxDepth) fail('$', `nests deeper than ${CapsuleLimits.maxDepth} levels`);
    const children = Array.isArray(value) ? value : isObj(value) ? Object.values(value) : [];
    for (const child of children) if (typeof child === 'object' && child !== null) stack.push([child, depth + 1]);
  }
}

/**
 * Null when `doc` is a valid v1 or v2 document, otherwise `<json path>
 * <reason>`. Does not check `specVersion` against the reader's version (the
 * codec does that, with its own message).
 */
export function validateCapsuleDocument(doc: unknown): string | null {
  try {
    validate(doc);
    return null;
  } catch (e) {
    if (e instanceof Invalid) return e.message;
    throw e;
  }
}

function validate(root: unknown): void {
  const doc = object(root, '$');
  checkDepth(doc);
  if (doc.format !== 'bugcapsule.capsule') fail('$.format', 'must be "bugcapsule.capsule"');
  const specVersion = int(doc, 'specVersion', '$', 1);

  const mp = '$.manifest';
  const m = object(doc.manifest, mp);
  string(m, 'capsuleId', mp, 100);
  isoDate(m, 'createdAt', mp);
  oneOf(m, 'mode', mp, ['debug', 'qa', 'production']);

  const app = object(m.app, `${mp}.app`);
  string(app, 'version', `${mp}.app`, 200);
  string(app, 'build', `${mp}.app`, 200);
  for (const k of ['id', 'name', 'flavor']) optString(app, k, `${mp}.app`, 200);

  const source = optObject(m, 'source', mp);
  if (source) {
    optString(source, 'gitSha', `${mp}.source`, 200);
    optBool(source, 'dirty', `${mp}.source`);
  }
  const sdk = optObject(m, 'sdk', mp);
  if (sdk) {
    optString(sdk, 'name', `${mp}.sdk`, 100);
    optString(sdk, 'version', `${mp}.sdk`, 100);
  }
  optInt(m, 'stateSchemaVersion', mp);

  const pp = `${mp}.platform`;
  const platform = object(m.platform, pp);
  string(platform, 'os', pp, 100);
  optString(platform, 'osVersion', pp, 200);
  optString(platform, 'locale', pp, 100);
  optString(platform, 'dartVersion', pp, 200);
  const screen = optObject(platform, 'screen', pp);
  if (screen) for (const k of ['width', 'height', 'pixelRatio']) optNum(screen, k, `${pp}.screen`);

  const sp = `${mp}.session`;
  const session = object(m.session, sp);
  string(session, 'id', sp, 200);
  isoDate(session, 'startedAt', sp);
  int(session, 'wallClockAtAnchorMs', sp);
  int(session, 'seed', sp);
  int(session, 'durationMs', sp);

  const failure = optObject(m, 'failure', mp);
  if (failure) validateFailure(failure, `${mp}.failure`);

  const ep = `${mp}.eligibility`;
  const eligibility = object(m.eligibility, ep);
  oneOf(eligibility, 'status', ep, ['eligible', 'partial', 'ineligible']);
  if (eligibility.missing !== undefined && eligibility.missing !== null) {
    const missing = array(eligibility.missing, `${ep}.missing`, CapsuleLimits.maxMissing);
    missing.forEach((entry, i) => {
      const path = `${ep}.missing[${i}]`;
      const item = object(entry, path);
      string(item, 'dependency', path, 200);
      string(item, 'reason', path, 2000, 0);
      optBool(item, 'blocking', path);
    });
  }

  if (m.integrations !== undefined && m.integrations !== null) {
    const integrations = array(m.integrations, `${mp}.integrations`, CapsuleLimits.maxIntegrations);
    integrations.forEach((v, i) => {
      if (typeof v !== 'string' || v.length === 0 || v.length > 100) {
        fail(`${mp}.integrations[${i}]`, 'must be a non-empty string of at most 100 characters');
      }
    });
  }

  const stats = optObject(m, 'stats', mp);
  if (stats) {
    optInt(stats, 'eventCount', `${mp}.stats`, 0);
    optInt(stats, 'droppedEvents', `${mp}.stats`, 0);
    if (stats.checkpointKind !== undefined && stats.checkpointKind !== null) {
      oneOf(stats, 'checkpointKind', `${mp}.stats`, ['launch', 'periodic']);
    }
  }

  const labels = optObject(m, 'labels', mp);
  if (labels) {
    stringMap(labels, `${mp}.labels`, CapsuleLimits.maxLabels, 2000);
    for (const k of Object.keys(labels)) if (k.length > 100) fail(`${mp}.labels`, 'keys must be at most 100 characters');
  }

  const redaction = optObject(m, 'redaction', mp);
  if (redaction) {
    for (const k of ['extraKeys', 'extraHeaders']) {
      if (redaction[k] === undefined || redaction[k] === null) continue;
      const list = array(redaction[k], `${mp}.redaction.${k}`, CapsuleLimits.maxRedactionKeys);
      list.forEach((v, i) => {
        if (typeof v !== 'string' || v.length > 200) fail(`${mp}.redaction.${k}[${i}]`, 'must be a string');
      });
    }
  }

  const runtime = optObject(m, 'runtime', mp);
  if (runtime) {
    const rp = `${mp}.runtime`;
    string(runtime, 'name', rp, 50);
    optString(runtime, 'version', rp, 200);
    optString(runtime, 'language', rp, 50);
    if (runtime.frameworks !== undefined && runtime.frameworks !== null) {
      const list = array(runtime.frameworks, `${rp}.frameworks`, CapsuleLimits.maxFrameworks);
      list.forEach((v, i) => {
        if (typeof v !== 'string' || v.length === 0 || v.length > 50) {
          fail(`${rp}.frameworks[${i}]`, 'must be a non-empty string of at most 50 characters');
        }
      });
    }
  }
  const capabilities = optObject(m, 'capabilities', mp);
  if (capabilities) {
    stringMap(capabilities, `${mp}.capabilities`, CapsuleLimits.maxCapabilities, 100);
    for (const k of Object.keys(capabilities)) {
      if (k.length > 100) fail(`${mp}.capabilities`, 'keys must be at most 100 characters');
    }
  }

  const links = optObject(m, 'links', mp);
  if (links) {
    const sentry = optObject(links, 'sentry', `${mp}.links`);
    if (sentry) {
      const sp = `${mp}.links.sentry`;
      if (typeof sentry.eventId !== 'string' || !SENTRY_EVENT_ID.test(sentry.eventId)) {
        fail(`${sp}.eventId`, 'must be 32 lowercase hex characters');
      }
      for (const k of ['projectId', 'orgId', 'release', 'environment']) optString(sentry, k, sp, 200);
    }
  }

  // capsule-v2 §2: interaction dependencies (ignored in v1 documents).
  const dependencies = specVersion >= 2 ? validateDependencies(m.dependencies, `${mp}.dependencies`) : null;

  const cp = '$.checkpoint';
  const checkpoint = object(doc.checkpoint, cp);
  oneOf(checkpoint, 'kind', cp, ['launch', 'periodic']);
  int(checkpoint, 't', cp);
  int(checkpoint, 'wallClockMs', cp);
  optInt(checkpoint, 'afterSeq', cp, 0);
  const checkpointData = optObject(checkpoint, 'data', cp);
  if (dependencies && checkpointData) validateOpenInteractions(checkpointData, `${cp}.data`);

  const events = array(doc.events, '$.events', CapsuleLimits.maxEvents);
  let lastSeq: number | null = null;
  events.forEach((entry, i) => {
    const path = `$.events[${i}]`;
    const e = object(entry, path);
    const seq = int(e, 'seq', path);
    if (lastSeq !== null && seq <= lastSeq) fail(`${path}.seq`, 'must be greater than the previous seq');
    lastSeq = seq;
    int(e, 't', path);
    const type = string(e, 'type', path, 100);
    const data = optObject(e, 'data', path) ?? {};
    validateEventData(type, data, `${path}.data`);
    if (dependencies) validateInteraction(type, data, `${path}.data`, dependencies);
  });
}

function validateFailure(f: Obj, path: string): void {
  oneOf(f, 'kind', path, ['exception', 'assertion', 'manual']);
  string(f, 'signature', path, 1000);
  string(f, 'type', path, 1000, 0);
  optString(f, 'message', path, 10_000);
  optString(f, 'stack', path, 20_000);
  optString(f, 'assertionId', path, 200);
  optInt(f, 't', path);
}

function validateEventData(type: string, d: Obj, path: string): void {
  switch (type) {
    case 'http': {
      string(d, 'key', path, 10_000);
      optInt(d, 'occurrence', path, 0);
      optInt(d, 'status', path);
      optInt(d, 'durationMs', path, 0);
      optString(d, 'bodyEncoding', path, 20);
      optString(d, 'statusMessage', path, 1000);
      const headers = optObject(d, 'responseHeaders', path);
      if (headers) stringMap(headers, `${path}.responseHeaders`);
      optObject(d, 'error', path);
      break;
    }
    case 'pointer':
      string(d, 'phase', path, 20);
      int(d, 'pointer', path);
      for (const k of ['x', 'y']) {
        const v = d[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${k}`, 'must be a number');
      }
      optInt(d, 'buttons', path);
      break;
    case 'action':
      string(d, 'id', path, 200);
      optObject(d, 'payload', path);
      break;
    case 'text':
      string(d, 'id', path, 200);
      optString(d, 'value', path, 100_000);
      break;
    case 'lifecycle':
      string(d, 'state', path, 20);
      break;
  }
}

function validateDependencies(value: unknown, path: string): Set<string> {
  const list = array(value, path, CapsuleLimits.maxDependencies);
  const ids = new Set<string>();
  list.forEach((entry, i) => {
    const p = `${path}[${i}]`;
    const d = object(entry, p);
    const id = string(d, 'id', p, 100);
    if (ids.has(id)) fail(`${p}.id`, 'must be unique');
    ids.add(id);
    string(d, 'kind', p, 50);
    string(d, 'adapter', p, 200);
    string(d, 'adapterVersion', p, 100);
    int(d, 'schema', p, 1);
    if (typeof d.required !== 'boolean') fail(`${p}.required`, 'must be a boolean');
    oneOf(d, 'coverage', p, ['complete', 'partial', 'diagnostic']);
    if (d.operations !== undefined && d.operations !== null) {
      array(d.operations, `${p}.operations`, CapsuleLimits.maxDependencyItems).forEach((v, j) => {
        if (typeof v !== 'string' || v.length === 0 || v.length > 200) fail(`${p}.operations[${j}]`, 'must be a non-empty string');
      });
    }
    if (d.tested !== undefined && d.tested !== null) {
      array(d.tested, `${p}.tested`, CapsuleLimits.maxTested).forEach((v, j) => {
        const t = object(v, `${p}.tested[${j}]`);
        string(t, 'package', `${p}.tested[${j}]`, 200);
        string(t, 'version', `${p}.tested[${j}]`, 100);
      });
    }
    if (d.gaps !== undefined && d.gaps !== null) {
      array(d.gaps, `${p}.gaps`, CapsuleLimits.maxDependencyItems).forEach((v, j) => {
        const g = object(v, `${p}.gaps[${j}]`);
        string(g, 'code', `${p}.gaps[${j}]`, 100);
        optInt(g, 'count', `${p}.gaps[${j}]`, 0);
        optString(g, 'detail', `${p}.gaps[${j}]`, 2000);
      });
    }
    const stats = optObject(d, 'stats', p);
    if (stats) for (const k of ['events', 'payloadBytes', 'dropped', 'truncated']) optInt(stats, k, `${p}.stats`, 0);
  });
  return ids;
}

function validateOpenInteractions(data: Obj, path: string): void {
  const interactions = optObject(data, 'interactions', path);
  if (!interactions || interactions.open === undefined || interactions.open === null) return;
  array(interactions.open, `${path}.interactions.open`, CapsuleLimits.maxDependencyItems * 10).forEach((entry, i) => {
    const p = `${path}.interactions.open[${i}]`;
    const o = object(entry, p);
    string(o, 'dep', p, 100);
    string(o, 'type', p, 50);
    string(o, 'id', p, 200);
    optBool(o, 'restorable', p);
  });
}

const PAYLOAD_MODES = ['full', 'redacted', 'metadata', 'omitted', 'truncated'] as const;

function payload(d: Obj, key: string, path: string): void {
  const v = d[key];
  if (v === undefined || v === null) return;
  const p = object(v, `${path}.${key}`);
  oneOf(p, 'mode', `${path}.${key}`, PAYLOAD_MODES);
  if (typeof p.replayable !== 'boolean') fail(`${path}.${key}.replayable`, 'must be a boolean');
  optInt(p, 'bytes', `${path}.${key}`, 0);
  optString(p, 'kind', `${path}.${key}`, 20);
}

/** capsule-v2 §9: the fields replay reads from interaction events. */
function validateInteraction(type: string, d: Obj, path: string, dependencies: Set<string>): void {
  if (!type.startsWith('ws.') && !type.startsWith('platform.') && !type.startsWith('native.')) return;
  const dep = string(d, 'dep', path, 100);
  if (!dependencies.has(dep)) fail(`${path}.dep`, 'must name a declared dependency');
  for (const field of ['payload', 'args', 'value', 'details']) payload(d, field, path);
  const keyed = () => {
    string(d, 'key', path, 10_000);
    int(d, 'occurrence', path, 0);
  };
  if (type.startsWith('ws.')) string(d, 'conn', path, 200);
  switch (type) {
    case 'ws.connect':
      keyed();
      break;
    case 'ws.send':
    case 'ws.message':
      int(d, 'index', path, 0);
      break;
    case 'ws.close':
      oneOf(d, 'initiator', path, ['client', 'server', 'unknown']);
      optInt(d, 'code', path);
      break;
    case 'platform.call':
      string(d, 'channel', path, 1000);
      string(d, 'call', path, 200);
      oneOf(d, 'dir', path, ['dart', 'platform']);
      keyed();
      break;
    case 'platform.result':
    case 'platform.error':
      string(d, 'channel', path, 1000);
      string(d, 'call', path, 200);
      break;
    case 'platform.listen':
      string(d, 'channel', path, 1000);
      string(d, 'sub', path, 200);
      keyed();
      break;
    case 'platform.event':
    case 'platform.cancel':
    case 'platform.done':
      string(d, 'channel', path, 1000);
      string(d, 'sub', path, 200);
      break;
    case 'native.call':
      string(d, 'op', path, 200);
      keyed();
      break;
    case 'native.result':
      string(d, 'op', path, 200);
      break;
    case 'native.subscribe':
      string(d, 'sub', path, 200);
      keyed();
      break;
    case 'native.event':
    case 'native.cancel':
    case 'native.done':
      string(d, 'sub', path, 200);
      break;
  }
}
