import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Pin the native engine independently of the web SDK package version.
export const CLI_VERSION = '0.4.1-beta.7';
const RELEASE = `https://github.com/BugCapsule/bug_capsule_flutter_sdk/releases/download/v${CLI_VERSION}`;
export function assetName(platform = process.platform, arch = process.arch) {
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(`${platform}-${arch}`)) {
    throw new Error(`Unsupported platform ${platform}/${arch}. See https://docs.bugcapsule.com/cli.html for standalone downloads.`);
  }
  return `bugcapsule-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}
const digest = data => createHash('sha256').update(data).digest('hex');
export async function ensureBinary({ cacheRoot = join(homedir(), '.bugcapsule', 'bin'), fetcher = fetch, platform = process.platform, arch = process.arch } = {}) {
  const name = assetName(platform, arch);
  const dir = join(cacheRoot, CLI_VERSION);
  const target = join(dir, name);
  try {
    const [data, checksum] = await Promise.all([readFile(target), readFile(`${target}.sha256`, 'utf8')]);
    if (digest(data) === checksum.trim()) return target;
  } catch { /* First use, interrupted download or corrupt cache: download again. */ }
  const checksumResponse = await fetcher(`${RELEASE}/${name}.sha256`, { signal: AbortSignal.timeout(120000) });
  if (!checksumResponse.ok) throw new Error(`CLI checksum download failed (HTTP ${checksumResponse.status}). Check your network and GitHub access, then retry.`);
  const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid CLI release checksum. Nothing was installed.');
  const response = await fetcher(`${RELEASE}/${name}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`CLI download failed (HTTP ${response.status}). Check your network and GitHub access, then retry.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (digest(data) !== checksum) throw new Error('CLI checksum mismatch. Nothing was installed; retry the download.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o755, flag: 'wx' });
    await chmod(temporary, 0o755);
    await rename(temporary, target);
    await writeFile(`${target}.sha256`, checksum, { mode: 0o600 });
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
export async function runNative(args) {
  const binary = await ensureBinary();
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit' });
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}
