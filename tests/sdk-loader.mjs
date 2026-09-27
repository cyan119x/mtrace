// Development-only resolver for the public SDK of a pinned OpenClaw installation.
// Set OPENCLAW_PACKAGE_ROOT to the installed OpenClaw package directory.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('openclaw/plugin-sdk/')) {
    const root = process.env.OPENCLAW_PACKAGE_ROOT;
    if (!root) throw new Error('Set OPENCLAW_PACKAGE_ROOT to your OpenClaw 2026.9.6 package directory');
    const modulePath = path.join(root, 'dist', 'plugin-sdk', specifier.slice('openclaw/plugin-sdk/'.length) + '.js');
    return nextResolve(pathToFileURL(modulePath).href, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return nextLoad(url, context);
}
