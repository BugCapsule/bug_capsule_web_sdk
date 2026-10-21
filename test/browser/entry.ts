import * as sdk from '../../packages/web/src/index.js';
import * as core from '../../packages/web/src/core/index.js';
import { UploadOutbox } from '../../packages/web/src/storage/outbox.js';
import { openStorage } from '../../packages/web/src/storage/idb.js';

(window as unknown as Record<string, unknown>).BC = sdk;
(window as unknown as Record<string, unknown>).BCCore = core;
(window as unknown as Record<string, unknown>).BCInternal = { UploadOutbox, openStorage };
