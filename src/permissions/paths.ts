/**
 * paths.ts — path safety for the permission gate. Canonicalizes paths (resolving
 * symlinks so an escape can't be hidden behind a link), tests containment within
 * a jail directory, and flags protected paths (.git, .ssh, .env, credentials,
 * and the harness's own config dir) that must never be read or written by a tool.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** Filenames/dirnames that are protected wherever they appear in a path. */
const PROTECTED_NAMES = new Set([
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'credentials',
]);

/**
 * Resolve `p` to an absolute, symlink-resolved path. For a path that does not
 * exist yet (e.g. a file about to be written), resolve the nearest existing
 * ancestor via realpath and re-join the remainder — so a symlinked parent
 * directory can't be used to escape a jail.
 */
export function canonicalize(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up to the first existing ancestor, realpath it, re-append the tail.
    const parent = dirname(abs);
    if (parent === abs) return abs; // reached the root
    try {
      return join(realpathSync(parent), basename(abs));
    } catch {
      return resolve(abs); // normalized best-effort
    }
  }
}

/** True if `child` is `parent` or lives inside it (both canonicalized first). */
export function isWithin(child: string, parent: string, cwd: string): boolean {
  const c = canonicalize(child, cwd);
  const p = canonicalize(parent, cwd);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * True if the path is protected: any path segment is a well-known sensitive
 * name, it lives under the harness config dir (~/.raven), or it is within one of
 * the explicitly-configured `protectedPaths`.
 */
export function isProtected(
  p: string,
  protectedPaths: string[],
  cwd: string,
): boolean {
  const canonical = canonicalize(p, cwd);
  const segments = canonical.split(/[\\/]+/);
  if (segments.some((seg) => PROTECTED_NAMES.has(seg))) return true;

  const configDir = join(homedir(), '.raven');
  if (isWithin(canonical, configDir, cwd)) return true;

  for (const protectedPath of protectedPaths) {
    if (protectedPath.length === 0) continue;
    if (isWithin(canonical, protectedPath, cwd)) return true;
  }
  return false;
}
