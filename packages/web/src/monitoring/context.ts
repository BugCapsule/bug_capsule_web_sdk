/** Default `contexts` of web events (monitoring-v1 §2 well-known keys `browser`, `os`, `screen`, `culture`). */

type UaData = { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean };

export function browserContext(ua: string, uaData?: UaData): { name: string; version: string } {
  const brands = uaData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand) && b.brand !== 'Chromium');
  if (brands && brands.length > 0) return { name: brands[0]!.brand, version: brands[0]!.version };
  const tests: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [re, name] of tests) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1]! };
  }
  return { name: 'unknown', version: '' };
}

export function osContext(ua: string, uaData?: UaData): { name: string; version?: string } {
  const tests: [RegExp, string, (m: RegExpExecArray) => string | undefined][] = [
    [/Windows NT ([\d.]+)/, 'Windows', (m) => m[1]],
    [/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/, 'iOS', (m) => m[1]!.replace(/_/g, '.')],
    [/Android ([\d.]+)/, 'Android', (m) => m[1]],
    [/Mac OS X ([\d_.]+)/, 'macOS', (m) => m[1]!.replace(/_/g, '.')],
    [/CrOS/, 'Chrome OS', () => undefined],
    [/Linux/, 'Linux', () => undefined],
  ];
  for (const [re, name, version] of tests) {
    const m = re.exec(ua);
    if (m) {
      const v = version(m);
      return v ? { name, version: v } : { name };
    }
  }
  return uaData?.platform ? { name: uaData.platform } : { name: 'unknown' };
}

export function defaultContexts(): Record<string, Record<string, unknown>> {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: UaData }) | undefined;
  const ua = nav?.userAgent ?? '';
  const contexts: Record<string, Record<string, unknown>> = {
    browser: browserContext(ua, nav?.userAgentData),
    os: osContext(ua, nav?.userAgentData),
  };
  if (typeof globalThis.innerWidth === 'number') {
    contexts.screen = { width: globalThis.innerWidth, height: globalThis.innerHeight, pixelRatio: globalThis.devicePixelRatio ?? 1 };
  }
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  contexts.culture = { ...(nav?.language ? { locale: nav.language } : {}), ...(timezone ? { timezone } : {}) };
  return contexts;
}
