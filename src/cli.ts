#!/usr/bin/env node
/**
 * Recipe Context Builder - CLI
 * 
 * Consolidates Paprika 3 recipe exports into a normalized dataset
 * and generates ChatGPT-friendly context files for meal planning.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';

import { build } from './build.js';
import { loadRecipes, loadIndex, searchRecipes, formatSearchResults, formatStats } from './search.js';
import { getDefaultICloudPath } from './scanner.js';
import { getSampleConfigContent } from './config-loader.js';
import { validateOutput, testDeterminism, formatValidationResult } from './validator.js';
import type { MealType, PrimaryProtein } from './types.js';

const program = new Command();

program
  .name('recipe-context')
  .description('Consolidate Paprika recipe exports into ChatGPT-friendly context files')
  .version('1.0.0');

// ============================================================================
// BUILD Command
// ============================================================================

program
  .command('build')
  .description('Import and process recipes from a folder')
  .requiredOption('-i, --input <path>', 'Input folder containing recipe exports')
  .option('-o, --output <path>', 'Output folder for generated files', './dist/recipe-context')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)')
  .option('--max-chars <number>', 'Maximum characters in context file', parseInt)
  .option('--max-recipes <number>', 'Maximum recipes in context file', parseInt)
  .option('-f, --format <type>', 'Output format: markdown, jsonl, or both', 'both')
  .option('-v, --verbose', 'Show verbose output')
  .action(async (options) => {
    console.log(chalk.bold('\n🍳 Recipe Context Builder\n'));

    const inputPath = resolve(options.input);
    const outputPath = resolve(options.output);

    // Check if input path exists
    if (!existsSync(inputPath)) {
      console.error(chalk.red(`Error: Input path does not exist: ${inputPath}`));
      console.log(chalk.dim(`\nTip: Your iCloud Drive path is typically:`));
      console.log(chalk.dim(`  ${getDefaultICloudPath()}`));
      process.exit(1);
    }

    const spinner = ora('Starting build...').start();

    try {
      const result = await build(
        {
          inputPath,
          outputPath,
          configPath: options.config,
          maxChars: options.maxChars,
          maxRecipesInContext: options.maxRecipes,
          format: options.format,
          verbose: options.verbose,
        },
        (progress) => {
          spinner.text = `[${progress.phase}] ${progress.message}`;
        }
      );

      spinner.succeed('Build complete!');

      // Print summary
      console.log('\n' + chalk.bold('📊 Summary'));
      console.log(chalk.dim('─'.repeat(40)));
      
      const table = new Table({
        style: { head: [], border: [] },
      });

      table.push(
        [chalk.dim('Recipes processed:'), chalk.green(result.recipesProcessed.toString())],
        [chalk.dim('Unique recipes:'), chalk.green(result.uniqueRecipes.toString())],
        [chalk.dim('Duplicates found:'), chalk.yellow(result.duplicatesFound.toString())],
        [chalk.dim('Parse errors:'), result.errors.length > 0 ? chalk.red(result.errors.length.toString()) : chalk.green('0')],
      );

      console.log(table.toString());

      console.log('\n' + chalk.bold('📁 Output files'));
      console.log(chalk.dim('─'.repeat(40)));
      console.log(`  ${chalk.cyan('recipes.normalized.jsonl')} - All recipes in JSONL format`);
      console.log(`  ${chalk.cyan('recipes.index.json')} - Searchable index`);
      console.log(`  ${chalk.cyan('context.project.md')} - ChatGPT project context`);
      console.log(`  ${chalk.cyan('recipes/')} - Individual recipe markdown files`);
      console.log(`  ${chalk.cyan('report.md')} - Import report with stats`);
      console.log(`\n  Output folder: ${chalk.underline(outputPath)}`);

      if (result.errors.length > 0 && options.verbose) {
        console.log('\n' + chalk.yellow('⚠️  Parse errors:'));
        for (const error of result.errors.slice(0, 5)) {
          console.log(chalk.dim(`  ${error.file}: ${error.error}`));
        }
        if (result.errors.length > 5) {
          console.log(chalk.dim(`  ...and ${result.errors.length - 5} more. See report.md for details.`));
        }
      }

      console.log();

    } catch (err) {
      spinner.fail('Build failed');
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// ============================================================================
// SEARCH Command
// ============================================================================

program
  .command('search')
  .description('Search recipes in the built dataset')
  .option('-q, --query <text>', 'Search query (matches title, ingredients, tags)')
  .option('-t, --tags <tags>', 'Filter by tags (comma-separated)')
  .option('-m, --meal-type <type>', 'Filter by meal type')
  .option('-p, --protein <type>', 'Filter by primary protein')
  .option('--max-time <minutes>', 'Maximum total time in minutes', parseInt)
  .option('--weeknight', 'Show only weeknight-friendly (score > 0.6)')
  .option('--kid-friendly', 'Show only kid-friendly (score > 0.6)')
  .option('-l, --limit <number>', 'Maximum results to show', parseInt, 20)
  .option('-d, --data <path>', 'Path to recipe data folder', './dist/recipe-context')
  .action(async (options) => {
    const dataPath = resolve(options.data);

    if (!existsSync(join(dataPath, 'recipes.normalized.jsonl'))) {
      console.error(chalk.red(`Error: No recipe data found at ${dataPath}`));
      console.log(chalk.dim('Run "recipe-context build" first to generate the data.'));
      process.exit(1);
    }

    try {
      const recipes = await loadRecipes(dataPath);

      const results = searchRecipes(recipes, {
        query: options.query,
        tags: options.tags?.split(',').map((t: string) => t.trim()),
        mealType: options.mealType as MealType,
        protein: options.protein as PrimaryProtein,
        maxTime: options.maxTime,
        minWeeknightScore: options.weeknight ? 0.6 : undefined,
        minKidFriendlyScore: options.kidFriendly ? 0.6 : undefined,
        limit: options.limit,
      });

      console.log('\n' + formatSearchResults(results));

    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// ============================================================================
// STATS Command
// ============================================================================

program
  .command('stats')
  .description('Show statistics about the recipe collection')
  .option('-d, --data <path>', 'Path to recipe data folder', './dist/recipe-context')
  .action(async (options) => {
    const dataPath = resolve(options.data);

    if (!existsSync(join(dataPath, 'recipes.index.json'))) {
      console.error(chalk.red(`Error: No recipe data found at ${dataPath}`));
      console.log(chalk.dim('Run "recipe-context build" first to generate the data.'));
      process.exit(1);
    }

    try {
      const index = await loadIndex(dataPath);
      console.log('\n' + formatStats(index) + '\n');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// ============================================================================
// INIT Command
// ============================================================================

program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <path>', 'Output path for config file', './config.yaml')
  .action(async (options) => {
    const outputPath = resolve(options.output);

    if (existsSync(outputPath)) {
      console.error(chalk.yellow(`Config file already exists: ${outputPath}`));
      console.log(chalk.dim('Use a different path or delete the existing file.'));
      process.exit(1);
    }

    try {
      await writeFile(outputPath, getSampleConfigContent());
      console.log(chalk.green(`\n✅ Created config file: ${outputPath}`));
      console.log(chalk.dim('\nEdit this file to customize your preferences, then use:'));
      console.log(chalk.cyan(`  recipe-context build -i <input> -c ${options.output}\n`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// ============================================================================
// VALIDATE Command
// ============================================================================

program
  .command('validate')
  .description('Validate output for ChatGPT Plus readiness')
  .option('-o, --output <path>', 'Path to output folder to validate', './dist/recipe-context')
  .option('--min-recipes <number>', 'Minimum required recipes', parseInt, 20)
  .option('--max-chars <number>', 'Maximum context file size', parseInt, 200000)
  .action(async (options) => {
    const outputPath = resolve(options.output);

    if (!existsSync(outputPath)) {
      console.error(chalk.red(`Error: Output path does not exist: ${outputPath}`));
      process.exit(1);
    }

    console.log(chalk.bold('\n🔍 Validating Recipe Context Output\n'));
    console.log(chalk.dim(`Output path: ${outputPath}\n`));

    const spinner = ora('Running validation checks...').start();

    try {
      const result = await validateOutput(outputPath, {
        minRecipes: options.minRecipes,
        maxContextChars: options.maxChars,
      });

      spinner.stop();

      console.log(formatValidationResult(result));

      // Test determinism
      console.log('\n' + chalk.bold('Determinism Check:'));
      const determinismResult = await testDeterminism(outputPath);
      if (determinismResult.deterministic) {
        console.log(chalk.green(`  ✓ ${determinismResult.details}`));
      } else {
        console.log(chalk.yellow(`  ⚠ ${determinismResult.details}`));
      }

      console.log();

      if (result.valid) {
        console.log(chalk.green('✅ Output is ready for ChatGPT Plus Project!\n'));
        console.log(chalk.bold('Next Steps:'));
        console.log('  1. Open ChatGPT Plus and create a new Project');
        console.log('  2. Upload context.project.md as the Project instructions');
        console.log('  3. Upload recipes.normalized.jsonl as a Project file');
        console.log('  4. Use prompts from prompt.examples.md to get started\n');
      } else {
        console.log(chalk.red('❌ Output has validation errors. Please fix and re-run build.\n'));
        process.exit(1);
      }

    } catch (err) {
      spinner.fail('Validation failed');
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// ============================================================================
// INFO Command
// ============================================================================

program
  .command('info')
  .description('Show helpful information about locating recipe exports')
  .action(() => {
    console.log(chalk.bold('\n📍 Locating Your Recipe Exports\n'));
    
    console.log(chalk.bold('iCloud Drive Path:'));
    console.log(`  ${chalk.cyan(getDefaultICloudPath())}`);
    console.log();
    
    console.log(chalk.bold('Paprika Export Folder:'));
    console.log('  Look for folders named like:');
    console.log(chalk.dim('    "Export 2025-11-12 22.30.23 Todo"'));
    console.log();

    console.log(chalk.bold('Supported File Formats:'));
    console.log('  • .paprikarecipe / .paprikarecipes (native format)');
    console.log('  • .html / .htm (HTML exports)');
    console.log('  • .txt (plain text exports)');
    console.log('  • .json (JSON exports)');
    console.log('  • .mcb / .zip (compressed archives)');
    console.log();

    console.log(chalk.bold('Example Usage:'));
    console.log(chalk.cyan('  recipe-context build -i "~/Library/Mobile Documents/com~apple~CloudDocs/Export 2025-11-12 22.30.23 Todo"'));
    console.log();
  });

program.parse();
