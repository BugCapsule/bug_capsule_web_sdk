/**
 * The persisted collection (consent) switch, BC-ENT-038. Stored in
 * localStorage so it is known synchronously at `init`, before IndexedDB
 * opens. Every access is guarded: storage can be blocked (sandboxed iframes,
 * some private windows), and then the switch lasts for the page only.
 */
export function consentKey(storageName = 'bugcapsule'): string {
  return `bugcapsule:${storageName}:collectionEnabled`;
}

/** The persisted choice, or null when none was made (or storage is unreadable). */
export function readConsent(storageName?: string): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(consentKey(storageName));
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Persists the choice; false when it could not be stored. */
export function writeConsent(enabled: boolean, storageName?: string): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem(consentKey(storageName), enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
