import { ToolError } from './errors.js';

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const roots = new Set(['src', 'scratch', 'imports']);

/** Canonical virtual path; deliberately does not normalize ambiguous input. */
export function canonicalPath(path: string, options: { write?: boolean; directory?: boolean } = {}): string {
  if (typeof path !== 'string' || path.length > 1024 || path.includes('\\') || path !== path.normalize('NFC')) {
    throw new ToolError('PATH_DENIED', 'Path must be an unambiguous canonical virtual path.');
  }
  if (options.directory && path === '') return path;
  if (path === 'main.pjs' || path === 'index.html') return path;
  const parts = path.split('/');
  if (!roots.has(parts[0] ?? '') || (!options.directory && parts.length < 2) ||
      parts.some(part => part === '.' || part === '..' || !segment.test(part))) {
    throw new ToolError('PATH_DENIED', 'Use main.pjs, index.html, src/…, scratch/… or imports/… without traversal.');
  }
  if (options.write && parts[0] === 'imports') {
    throw new ToolError('PATH_DENIED', 'Imports are revision-pinned and read-only.', 'Write a copy under scratch/ or src/.');
  }
  return path;
}

export const validatePath = canonicalPath;

export function assertNoPathCollisions(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    canonicalPath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ToolError('PATH_DENIED', 'Duplicate or case-colliding paths are not allowed.');
    seen.add(key);
  }
}

export function validateGlob(pattern: string): string {
  if (!pattern || pattern.length > 512 || pattern.startsWith('/') || pattern.includes('\\') ||
      pattern.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f\x7f]/.test(pattern)) {
    throw new ToolError('PATH_DENIED', 'Glob must be a bounded relative pattern without traversal.');
  }
  return pattern;
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
