// Uses the npm version pinned by publish.yml to produce npm-compatible bundles.
// The owner can publish the exact archive with --provenance-file after download.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { generateProvenance, verifyProvenance } = require(path.join(globalRoot, 'npm/node_modules/libnpmpublish/lib/provenance.js'));
const npa = require(path.join(globalRoot, 'npm/node_modules/npm-package-arg'));
// Rekor may accept a submission and return a conflict when its client retries.
async function signSubject(subject) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await generateProvenance([subject], { timeout: 60000 });
    } catch (error) {
      if (attempt >= 3 || error.code !== 'TLOG_CREATE_ENTRY_ERROR' ||
          error.cause?.statusCode !== 409 && !error.message.includes('(409)')) throw error;
      console.warn('Transparency log reported a duplicate entry; requesting a fresh signature.');
    }
  }
}
const allowed = new Set(['packages/web', 'packages/react', 'packages/web-replay', 'packages/cli', 'packages/emergency-guard']);
(async () => {
  const packages = (process.env.PACKAGES || '').trim().split(/\s+/);
  if (!packages.length || packages.some(p => !allowed.has(p))) throw new Error('Unknown package selection');
  await fs.mkdir('dist-signed', { recursive: true });
  const manifest = [];
  for (const workspace of packages) {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '-w', workspace, '--json', '--pack-destination', 'dist-signed'], { encoding: 'utf8' }));
    const archive = path.join('dist-signed', packed.filename);
    const digest = createHash('sha512').update(await fs.readFile(archive)).digest('hex');
    const subject = { name: npa.toPurl(npa.resolve(packed.name, packed.version)), digest: { sha512: digest } };
    const bundle = await signSubject(subject);
    const provenance = archive + '.sigstore';
    await fs.writeFile(provenance, JSON.stringify(bundle));
    await verifyProvenance(subject, provenance);
    manifest.push({ name: packed.name, version: packed.version, archive: packed.filename, sha512: digest, provenance: path.basename(provenance), commit: process.env.GITHUB_SHA });
  }
  await fs.writeFile('dist-signed/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
