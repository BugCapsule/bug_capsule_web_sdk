/**
 * Environment-neutral core of the BugCapsule web SDK: capsule model (spec
 * v1 and v2), codec with bounded decoding, validation, redaction, request
 * keys, fixtures, typed values and interaction scheduling (capsule-v2),
 * flight recorder, verdict rules and the replay protocol types. Usable in browsers,
 * workers and Node (the replay runner).
 */
export * from './json.js';
export * from './uri.js';
export * from './model.js';
export * from './failure.js';
export * from './redaction.js';
export * from './network.js';
export * from './typed-value.js';
export * from './interactions.js';
export * from './validator.js';
export * from './codec.js';
export * from './recorder.js';
export * from './idle.js';
export * from './protocol.js';
export * from './verdict.js';
