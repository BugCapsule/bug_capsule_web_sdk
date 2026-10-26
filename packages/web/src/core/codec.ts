import { countJsonValues, utf8Decode, utf8Encode } from './json.js';
import { CAPSULE_FORMAT, SPEC_VERSION, specVersionFor, type Capsule, type Manifest } from './model.js';
import { CapsuleLimits, validateCapsuleDocument } from './validator.js';

export class CapsuleFormatError extends Error {
  override name = 'CapsuleFormatError';
}

/** Bounds what a hostile file can make the reader allocate (same as the Dart reader). */
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Gzip implementation: browsers use (De)CompressionStream; Node passes zlib-based ones. */
export interface GzipCodec {
  gzip(bytes: Uint8Array): Promise<Uint8Array>;
  /** Must throw (or reject) as soon as the output exceeds `maxBytes`. */
  gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array>;
}

class TooLarge extends Error {}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** CompressionStream-based gzip (browsers, Node 18+, workers). */
export const streamGzip: GzipCodec = {
  async gzip(bytes) {
    return readCapped(streamOf(bytes).pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), Number.MAX_SAFE_INTEGER);
  },
  async gunzip(bytes, maxBytes) {
    try {
      return await readCapped(streamOf(bytes).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), maxBytes);
    } catch (e) {
      if (e instanceof TooLarge) throw new CapsuleFormatError(`decompressed capsule exceeds ${maxBytes} bytes`);
      throw new CapsuleFormatError('not a valid gzip file');
    }
  },
};

/** The document a writer emits: spec v2 only when the capsule has interaction dependencies, else v1. */
export function capsuleToJson(capsule: Capsule): Capsule {
  return {
    format: CAPSULE_FORMAT,
    specVersion: specVersionFor(capsule.manifest),
    manifest: capsule.manifest,
    checkpoint: capsule.checkpoint,
    events: capsule.events,
  };
}

export async function encodeCapsule(capsule: Capsule, codec: GzipCodec = streamGzip): Promise<Uint8Array> {
  return codec.gzip(utf8Encode(JSON.stringify(capsuleToJson(capsule))));
}

/**
 * Decodes a `.bugcapsule` (spec v1 or v2): gzip magic, bounded inflate,
 * JSON value count before parsing, format/specVersion (newer than v2 is
 * rejected), then full structural validation.
 * Every problem is a {@link CapsuleFormatError} naming the JSON path.
 */
export async function decodeCapsule(
  bytes: Uint8Array,
  options: { maxDecompressedBytes?: number; codec?: GzipCodec } = {},
): Promise<Capsule> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new CapsuleFormatError('not a gzip file');
  const max = options.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const raw = await (options.codec ?? streamGzip).gunzip(bytes, max);
  return decodeCapsuleJson(raw);
}

/** Decodes uncompressed capsule JSON bytes (same checks as {@link decodeCapsule} after inflating). */
export function decodeCapsuleJson(raw: Uint8Array): Capsule {
  if (countJsonValues(raw, CapsuleLimits.maxJsonValues) > CapsuleLimits.maxJsonValues) {
    throw new CapsuleFormatError(`$ has more than ${CapsuleLimits.maxJsonValues} JSON values`);
  }
  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(raw));
  } catch (e) {
    throw new CapsuleFormatError(`invalid JSON: ${(e as Error).message}`);
  }
  return capsuleFromJson(json);
}

export function capsuleFromJson(json: unknown): Capsule {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new CapsuleFormatError('top level is not an object');
  }
  const doc = json as Record<string, unknown>;
  if (doc.format !== CAPSULE_FORMAT) {
    throw new CapsuleFormatError(`$.format must be "${CAPSULE_FORMAT}" (got "${String(doc.format)}")`);
  }
  const version = doc.specVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new CapsuleFormatError('$.specVersion must be an integer');
  }
  if (version > SPEC_VERSION) {
    throw new CapsuleFormatError(`$.specVersion ${version} is newer than this reader (v${SPEC_VERSION}); update @bugcapsule/web`);
  }
  const problem = validateCapsuleDocument(doc);
  if (problem !== null) throw new CapsuleFormatError(`malformed capsule: ${problem}`);
  const checkpoint = doc.checkpoint as Record<string, unknown>;
  let manifest = doc.manifest as Manifest;
  if (version < 2 && 'dependencies' in manifest) {
    // capsule-v2 §1: dependencies have no effect on a v1 capsule.
    const { dependencies: _ignored, ...rest } = manifest;
    manifest = rest as Manifest;
  }
  return {
    format: CAPSULE_FORMAT,
    specVersion: version,
    manifest,
    checkpoint: {
      ...(checkpoint as unknown as Capsule['checkpoint']),
      afterSeq: (checkpoint.afterSeq as number | undefined) ?? 0,
      data: (checkpoint.data as Record<string, unknown> | undefined) ?? {},
    },
    events: (doc.events as Record<string, unknown>[]).map((e) => ({
      seq: e.seq as number,
      t: e.t as number,
      type: e.type as string,
      data: (e.data as Record<string, unknown> | undefined) ?? {},
    })),
  };
}
