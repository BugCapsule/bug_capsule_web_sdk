import { findBundles, injectFile, uploadSourcemaps } from './sourcemaps.js';

export * from './sourcemaps.js';

const USAGE = `bugcapsule-cli — BugCapsule build tooling for the web

Usage:
  bugcapsule-cli sourcemaps inject <dir|file>... [--dry-run]
      Writes a debug id into every bundle (//# debugId=… plus a small
      registration snippet) and into its source map ("debugId"). Run it on
      the build output before deploying and before uploading.

  bugcapsule-cli sourcemaps upload <dir|file>... --url <backend> [--release <version>]
                 [--url-prefix ~/assets] [--no-sources] [--dry-run]
      Uploads source maps (and, with --release, the bundles) to
      POST /v1/debug-files. Needs the project secret key (bcs_…) in
      BUGCAPSULE_SECRET_KEY or --key. --url defaults to BUGCAPSULE_URL.

Never ship source maps or the secret key to browsers.
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) flags[a.substring(2, eq)] = a.substring(eq + 1);
    else if (['dry-run', 'no-sources', 'help'].includes(a.substring(2))) flags[a.substring(2)] = true;
    else flags[a.substring(2)] = argv[++i] ?? '';
  }
  return { positional, flags };
}

/** CLI entry point; resolves to the exit code. */
export async function main(argv: string[], io: { out?: (s: string) => void; err?: (s: string) => void; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<number> {
  const out = io.out ?? ((s: string) => process.stdout.write(s));
  const err = io.err ?? ((s: string) => process.stderr.write(s));
  const env = io.env ?? process.env;
  const { positional, flags } = parse(argv);
  const [group, command, ...paths] = positional;
  if (flags.help || group !== 'sourcemaps' || (command !== 'inject' && command !== 'upload')) {
    (flags.help ? out : err)(USAGE);
    return flags.help ? 0 : 2;
  }
  if (paths.length === 0) {
    err('error: give at least one build directory or bundle\n');
    return 2;
  }
  const dryRun = flags['dry-run'] === true;
  if (command === 'inject') {
    const files = await findBundles(paths);
    let changed = 0;
    for (const file of files) {
      const r = await injectFile(file, { dryRun });
      if (r.changed) changed++;
      out(`${r.changed ? (dryRun ? 'would inject' : 'injected') : 'unchanged'} ${r.debugId} ${file}${r.map ? '' : ' (no source map)'}\n`);
    }
    out(`${files.length} bundles, ${changed} ${dryRun ? 'would change' : 'changed'}\n`);
    return 0;
  }
  const url = typeof flags.url === 'string' ? flags.url : env.BUGCAPSULE_URL;
  const key = typeof flags.key === 'string' ? flags.key : env.BUGCAPSULE_SECRET_KEY;
  if (!url) {
    err('error: --url (or BUGCAPSULE_URL) is required\n');
    return 2;
  }
  if (!key && !dryRun) {
    err('error: the project secret key is required: BUGCAPSULE_SECRET_KEY or --key\n');
    return 2;
  }
  try {
    const uploaded = await uploadSourcemaps(paths, {
      url,
      secretKey: key ?? '',
      ...(typeof flags.release === 'string' ? { release: flags.release } : {}),
      ...(typeof flags['url-prefix'] === 'string' ? { urlPrefix: flags['url-prefix'] } : {}),
      sources: flags['no-sources'] !== true,
      dryRun,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      log: (line) => out(`${line}\n`),
    });
    out(`${uploaded.length} files ${dryRun ? 'would be uploaded' : 'uploaded'}\n`);
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}\n`);
    return 1;
  }
}
