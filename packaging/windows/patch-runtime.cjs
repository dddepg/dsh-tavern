// Desktop 2.0.13 already embeds UTF-8 code-page prologues in Windows command
// shims. This patch only isolates package management from Electron on Windows.
const fs = require('original-fs');
const path = require('node:path');
const runtime = path.resolve(process.argv[2]);
const hostRoot = fs.existsSync(path.join(runtime, 'resources', 'app', 'package.json'))
  ? path.join(runtime, 'resources', 'app')
  : path.join(runtime, 'resources', 'app.asar.unpacked');

// Package management must not run worker threads inside Electron on Windows.
// Keep the original entry beside the bridge so its relative imports still resolve.
const helper = path.join(runtime, 'resources', 'desktop-package-manager.mjs');
fs.copyFileSync(process.argv[3], helper);
const pnpmEntry = path.join(hostRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const pnpmOriginal = path.join(path.dirname(pnpmEntry), 'pnpm-desktop-original.mjs');
fs.copyFileSync(pnpmEntry, pnpmOriginal);
const helperRelative = path.relative(path.dirname(pnpmEntry), helper).replaceAll('\\', '/');
fs.writeFileSync(pnpmEntry, `#!/usr/bin/env node
if (process.platform === 'win32' && process.versions.electron && process.argv.slice(2).some(arg => ['install','i','add','update','up','remove','prune','rebuild'].includes(arg))) {
  const { prepareDesktopPackageManager } = await import(${JSON.stringify(helperRelative)});
  const { fileURLToPath } = await import('node:url');
  const { spawn } = await import('node:child_process');
  const manager = await prepareDesktopPackageManager({host:'desktop', entry:fileURLToPath(new URL('./pnpm-desktop-original.mjs', import.meta.url)), onProgress:console.error});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const child = spawn(manager.node, [manager.runner,...process.argv.slice(2)], {env, stdio:'inherit', windowsHide:true});
  const code = await new Promise(resolve => {child.on('error', error => {console.error(error.message);resolve(1)});child.on('exit', code => resolve(code ?? 1))});
  process.exit(code);
} else {
  await import('./pnpm-desktop-original.mjs');
}
`);
