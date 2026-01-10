/**
 * File Scanner - Recursively scans directories for recipe files
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, extname } from 'path';

export interface ScannedFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  content: Buffer;
}

export interface ScanResult {
  files: ScannedFile[];
  errors: Array<{ path: string; error: string }>;
  stats: {
    totalFiles: number;
    totalSize: number;
    byExtension: Record<string, number>;
  };
}

const SUPPORTED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.txt',
  '.paprikarecipe',
  '.paprikarecipes',
  '.mcb',
  '.zip',
  '.json',
]);

/**
 * Recursively scan a directory for recipe files
 */
export async function scanDirectory(rootPath: string): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const byExtension: Record<string, number> = {};

  async function scanDir(dirPath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        // Skip hidden files and directories
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          
          // Check if this is a supported file type
          if (SUPPORTED_EXTENSIONS.has(ext) || isLikelyRecipeFile(entry.name)) {
            try {
              const stats = await stat(fullPath);
              const content = await readFile(fullPath);
              
              files.push({
                path: fullPath,
                name: entry.name,
                extension: ext,
                size: stats.size,
                content,
              });

              byExtension[ext] = (byExtension[ext] || 0) + 1;
            } catch (err) {
              errors.push({
                path: fullPath,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        path: dirPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await scanDir(rootPath);

  return {
    files,
    errors,
    stats: {
      totalFiles: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      byExtension,
    },
  };
}

/**
 * Check if a file is likely a recipe file based on name patterns
 */
function isLikelyRecipeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  
  // Common recipe file patterns
  if (lower.includes('recipe')) return true;
  if (lower.endsWith('.paprika')) return true;
  
  return false;
}

/**
 * Get the iCloud Drive path for the current user
 */
export function getDefaultICloudPath(): string {
  const home = process.env.HOME || '~';
  return join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

/**
 * Validate that a path exists and is accessible
 */
export async function validatePath(path: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Path is not a directory' };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Path not accessible',
    };
  }
}
