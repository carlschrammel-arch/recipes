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
 * Recursively scan a directory (or a single recipe file) for recipe files.
 * When rootPath points to a file it is treated as a single-file import.
 */
export async function scanDirectory(rootPath: string): Promise<ScanResult> {
  // Handle single-file input (e.g. a .paprikarecipes archive)
  const rootStat = await stat(rootPath).catch(() => null);
  if (rootStat?.isFile()) {
    const ext = extname(rootPath).toLowerCase();
    try {
      const content = await readFile(rootPath);
      const file: ScannedFile = {
        path: rootPath,
        name: rootPath.split('/').pop()!,
        extension: ext,
        size: rootStat.size,
        content,
      };
      return {
        files: [file],
        errors: [],
        stats: { totalFiles: 1, totalSize: rootStat.size, byExtension: { [ext]: 1 } },
      };
    } catch (err) {
      return {
        files: [],
        errors: [{ path: rootPath, error: err instanceof Error ? err.message : String(err) }],
        stats: { totalFiles: 0, totalSize: 0, byExtension: {} },
      };
    }
  }

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

// Matches: "Export 2026-05-14 11.56.58 All Recipes"
const EXPORT_DATE_RE = /^Export (\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2})/;

export interface FoundExport {
  /** Absolute path — may be a directory or a .paprikarecipes file */
  path: string;
  name: string;
  date: Date;
  isFile: boolean;
}

/**
 * Scan iCloudRoot (defaults to ~/Library/Mobile Documents/com~apple~CloudDocs)
 * and return all Paprika export entries sorted newest-first.
 * Matches both folders and single .paprikarecipes files named like:
 *   "Export 2026-05-14 11.56.58 All Recipes"
 *   "Export 2026-05-14 11.56.58 All Recipes.paprikarecipes"
 */
export async function findPaprikaExports(
  iCloudRoot?: string,
): Promise<FoundExport[]> {
  const root = iCloudRoot ?? getDefaultICloudPath();
  const entries = await readdir(root, { withFileTypes: true });

  const exports: FoundExport[] = [];

  for (const entry of entries) {
    const m = EXPORT_DATE_RE.exec(entry.name);
    if (!m) continue;

    // Parse date: replace dots in time with colons for ISO parsing
    const datePart = m[1].replace(/(\d{2})\.(\d{2})\.(\d{2})$/, '$1:$2:$3');
    const date = new Date(datePart);
    if (isNaN(date.getTime())) continue;

    const isFile = entry.isFile() && entry.name.toLowerCase().endsWith('.paprikarecipes');
    const isDir  = entry.isDirectory();
    if (!isFile && !isDir) continue;

    exports.push({
      path: join(root, entry.name),
      name: entry.name,
      date,
      isFile,
    });
  }

  // Newest first
  exports.sort((a, b) => b.date.getTime() - a.date.getTime());
  return exports;
}

/**
 * Return the single most-recent Paprika export, or null if none found.
 */
export async function findLatestPaprikaExport(
  iCloudRoot?: string,
): Promise<FoundExport | null> {
  const all = await findPaprikaExports(iCloudRoot);
  return all[0] ?? null;
}

/**
 * Validate that a path exists and is accessible.
 * Accepts both directories and supported recipe files (.paprikarecipes, .zip, etc.).
 */
export async function validatePath(path: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory() && !stats.isFile()) {
      return { valid: false, error: 'Path is not a file or directory' };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Path not accessible',
    };
  }
}
