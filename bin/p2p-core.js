#!/usr/bin/env node
/**
 * p2p-core command line.
 *
 *   p2p-core serve [dir] [--port 8787] [--host 0.0.0.0] [--no-qr]
 *       Serve a game folder to the local network and connect its players,
 *       with no internet. Prints the address and a QR code to scan.
 *
 *   p2p-core vendor [dest]          (default dest: vendor/p2p-core)
 *       Copy the browser files into your project, for no-build apps that
 *       commit their dependencies. Re-run it after upgrading.
 *
 *   p2p-core files [prefix]
 *       Print the browser files, one per line, for a service worker's
 *       precache list. prefix defaults to ./vendor/p2p-core/
 *
 *   p2p-core version
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';
import { terminalQr } from '../server/terminal-qr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** What a browser needs. The server, the CLI and the tests stay behind. */
const BROWSER = ['p2p-core.js', 'p2p-core.d.ts', 'src', 'extras', 'vendor', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'AGENTS.md', 'package.json'];
/** Not worth precaching: documentation, types, licences and the lazily loaded QR scanner. */
const NOT_RUNTIME = /\.(md|d\.ts)$|LICENSE|package\.json$|vendor\/jsqr\//;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--no-')) flags[arg.slice(5)] = false;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      flags[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(dir, child));
    else out.push(child);
  }
  return out;
}

async function browserFiles() {
  const out = [];
  for (const item of BROWSER) {
    const full = path.join(ROOT, item);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) out.push(...(await listFiles(ROOT, item)));
    else out.push(item);
  }
  return out.sort();
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift() || 'help';

if (command === 'serve') {
  const root = positional[0] || '.';
  const port = Number(flags.port ?? process.env.PORT ?? 8787);
  const server = await startServer({ root, port, host: flags.host || '0.0.0.0', version: pkg.version });
  const lan = server.urls.filter((u) => !u.includes('localhost'));
  console.log('');
  console.log('  On this computer:   ' + server.urls[0]);
  for (const url of lan) console.log('  On the network:     ' + url);
  if (!lan.length) console.log('  (no network found — only this computer can join)');
  if (flags.qr !== false && lan.length) {
    console.log('\n  Scan to join:\n');
    console.log(terminalQr(lan[0]).split('\n').map((l) => '  ' + l).join('\n'));
  }
  console.log('\n  Players need no internet: just this Wi-Fi. Press Ctrl+C to stop.\n');
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (command === 'vendor') {
  const dest = path.resolve(positional[0] || 'vendor/p2p-core');
  if (dest === ROOT) { console.error('p2p-core: refusing to copy onto itself'); process.exit(1); }
  await fs.rm(dest, { recursive: true, force: true });
  for (const file of await browserFiles()) {
    const target = path.join(dest, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, file), target);
  }
  const rel = path.relative(process.cwd(), dest).split(path.sep).join('/');
  console.log(`p2p-core ${pkg.version} copied to ${rel}/`);
  console.log(`\n  import { joinRoom } from './${rel}/p2p-core.js';\n`);
  console.log(`Service worker? List the files with: npx p2p-core files ./${rel}/`);
} else if (command === 'files') {
  const prefix = positional[0] || './vendor/p2p-core/';
  for (const file of await browserFiles()) {
    if (flags.all || !NOT_RUNTIME.test(file)) console.log(prefix + file);
  }
} else if (command === 'version' || flags.version) {
  console.log(pkg.version);
} else {
  console.log(`p2p-core ${pkg.version}

  p2p-core serve [dir] [--port 8787] [--host 0.0.0.0] [--no-qr]
      Serve a game folder to this network and connect its players. No internet needed.

  p2p-core vendor [dest]
      Copy the browser files into your project (default: vendor/p2p-core).

  p2p-core files [prefix] [--all]
      List the runtime browser files, for a service worker precache list.

  p2p-core version
`);
}
