import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

export const uploadRoot = env.UPLOAD_DIR ?? fileURLToPath(new URL('../../uploads/', import.meta.url));

export async function createStagingDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, '.staging-'));
}

export async function retainFile(stagedPath: string, root: string): Promise<{ key: string; path: string }> {
  const key = randomUUID();
  const path = join(root, key);
  await chmod(stagedPath, 0o600);
  await rename(stagedPath, path);
  return { key, path };
}

export async function removeStagingDirectory(path: string, root: string): Promise<void> {
  // Verify the absolute deletion target is one generated child of upload storage.
  const target = resolve(path);
  if (dirname(target) !== resolve(root) || !basename(target).startsWith('.staging-')) {
    throw new Error('Invalid staging cleanup target');
  }
  await rm(target, { recursive: true, force: true });
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
