/**
 * Build Orchestrator - Main entry point for recipe processing
 */

import type { BuildOptions, NormalizedRecipe, ParseError, UserConfig } from './types.js';
import { scanDirectory, validatePath } from './scanner.js';
import { parseFile } from './parsers/index.js';
import { normalizeRecipe } from './normalizer.js';
import { deduplicateRecipes } from './deduplicator.js';
import { generateOutput } from './context-generator.js';
import { generateReport, writeReportMarkdown } from './report-generator.js';
import { loadUserConfig, mergeConfig, getDefaultConfig } from './config-loader.js';

export interface BuildProgress {
  phase: 'scanning' | 'parsing' | 'normalizing' | 'deduplicating' | 'generating' | 'complete';
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: BuildProgress) => void;

/**
 * Main build function - processes recipes from input to output
 */
export async function build(
  options: BuildOptions,
  onProgress?: ProgressCallback
): Promise<{
  success: boolean;
  recipesProcessed: number;
  uniqueRecipes: number;
  duplicatesFound: number;
  errors: ParseError[];
}> {
  const report = (phase: BuildProgress['phase'], current: number, total: number, message: string) => {
    onProgress?.({ phase, current, total, message });
  };

  // Validate input path
  const inputValidation = await validatePath(options.inputPath);
  if (!inputValidation.valid) {
    throw new Error(`Invalid input path: ${inputValidation.error}`);
  }

  // Load user config if provided
  let userConfig: UserConfig = getDefaultConfig();
  if (options.configPath) {
    try {
      const loadedConfig = await loadUserConfig(options.configPath);
      userConfig = mergeConfig(loadedConfig);
    } catch (err) {
      console.warn(`Warning: Could not load config file: ${err}`);
    }
  }

  // Apply CLI overrides
  if (options.maxChars) {
    userConfig.max_chars = options.maxChars;
  }
  if (options.maxRecipesInContext) {
    userConfig.max_recipes_in_context = options.maxRecipesInContext;
  }

  // Phase 1: Scan directory
  report('scanning', 0, 1, 'Scanning input directory...');
  const scanResult = await scanDirectory(options.inputPath);
  report('scanning', 1, 1, `Found ${scanResult.files.length} files`);

  if (scanResult.files.length === 0) {
    throw new Error('No recipe files found in input directory');
  }

  // Phase 2: Parse files
  const recipes: NormalizedRecipe[] = [];
  const parseErrors: ParseError[] = [];
  const byFormat: Record<string, number> = {};
  let filesParsed = 0;

  report('parsing', 0, scanResult.files.length, 'Parsing recipe files...');

  for (let i = 0; i < scanResult.files.length; i++) {
    const file = scanResult.files[i];
    
    try {
      const rawRecipes = await parseFile(file);
      
      // Track format
      byFormat[file.extension] = (byFormat[file.extension] || 0) + 1;

      // Phase 3: Normalize each recipe
      for (const raw of rawRecipes) {
        try {
          const normalized = normalizeRecipe(raw);
          recipes.push(normalized);
        } catch (err) {
          parseErrors.push({
            file: file.path,
            error: `Normalization error: ${err}`,
          });
        }
      }

      filesParsed++;
    } catch (err) {
      parseErrors.push({
        file: file.path,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    if (i % 10 === 0 || i === scanResult.files.length - 1) {
      report('parsing', i + 1, scanResult.files.length, `Parsed ${i + 1}/${scanResult.files.length} files`);
    }
  }

  if (recipes.length === 0) {
    throw new Error('No recipes could be parsed from input files');
  }

  // Phase 4: Deduplicate
  report('deduplicating', 0, 1, 'Finding duplicates...');
  const dedupeResult = deduplicateRecipes(recipes);
  report('deduplicating', 1, 1, `Found ${dedupeResult.stats.duplicatesFound} duplicates in ${dedupeResult.stats.duplicateGroups} groups`);

  // Phase 5: Generate output
  report('generating', 0, 4, 'Generating output files...');

  await generateOutput(
    dedupeResult,
    options.outputPath,
    userConfig,
    {
      maxChars: userConfig.max_chars || 200000,
      maxRecipesInContext: userConfig.max_recipes_in_context || 500,
      includePerRecipeMarkdown: options.format !== 'jsonl',
      hellofreshFormat: userConfig.hellofresh_format || false,
    }
  );

  report('generating', 2, 4, 'Writing report...');

  // Generate and write report
  const reportData = await generateReport({
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    filesScanned: scanResult.files.length,
    filesParsed,
    filesFailed: parseErrors.length,
    recipes: dedupeResult.recipes,
    duplicateGroups: dedupeResult.duplicateGroups,
    parseErrors,
    byFormat,
  });

  await writeReportMarkdown(reportData, options.outputPath);

  report('complete', 4, 4, 'Build complete!');

  return {
    success: true,
    recipesProcessed: recipes.length,
    uniqueRecipes: dedupeResult.stats.uniqueRecipes,
    duplicatesFound: dedupeResult.stats.duplicatesFound,
    errors: parseErrors,
  };
}
