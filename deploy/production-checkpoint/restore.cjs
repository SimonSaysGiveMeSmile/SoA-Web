// Recreate this exact static deployment without rebuilding or reading secrets.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../..');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function inside(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('Unsafe manifest path');
  }
  return path.join(root, relative);
}

(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, 'manifest.json'), 'utf8'));
  const destination = path.resolve(process.argv[2] || path.join(repo, '.vercel/output'));
  const verified = [];
  for (const file of manifest.files) {
    const data = await fs.readFile(inside(repo, file.source));
    if (digest(data) !== file.sha256) throw new Error('Checksum mismatch: ' + file.source);
    verified.push({ ...file, data });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // Exclusive creation preserves any existing build output.
  await fs.mkdir(destination);
  try {
    for (const file of verified) {
      const target = inside(destination, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.data, { flag: 'wx' });
    }
    for (const file of verified) {
      if (digest(await fs.readFile(inside(destination, file.path))) !== file.sha256) {
        throw new Error('Output checksum mismatch: ' + file.path);
      }
    }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  console.log(`Verified and restored ${verified.length} files from ${manifest.deploymentId}.`);
  console.log(`Build output: ${destination}`);
  console.log('No deployment was made. Use the checkpoint restore instructions to publish.');
})().catch(error => {
  console.error(error.code === 'EEXIST' ? 'Output already exists; choose a new destination.' : error.message);
  process.exitCode = 1;
});
