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
import { getDefaultICloudPath, findLatestPaprikaExport } from './scanner.js';
import { getSampleConfigContent } from './config-loader.js';
import { validateOutput, testDeterminism, formatValidationResult } from './validator.js';
import { askRecipes } from './ask.js';
import { planRecipes } from './planner/index.js';
import { createInterface } from 'readline';
import { loadHistory, saveHistory, appendToHistory } from './planner/history.js';
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
  .option('-i, --input <path>', 'Input folder or .paprikarecipes file (auto-detects latest iCloud export if omitted)')
  .option('-o, --output <path>', 'Output folder for generated files', './dist/recipe-context')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)')
  .option('--max-chars <number>', 'Maximum characters in context file', parseInt)
  .option('--max-recipes <number>', 'Maximum recipes in context file', parseInt)
  .option('-f, --format <type>', 'Output format: markdown, jsonl, or both', 'both')
  .option('-v, --verbose', 'Show verbose output')
  .action(async (options) => {
    console.log(chalk.bold('\n🍳 Recipe Context Builder\n'));

    let inputPath: string;

    if (options.input) {
      inputPath = resolve(options.input);
      if (!existsSync(inputPath)) {
        console.error(chalk.red(`Error: Input path does not exist: ${inputPath}`));
        process.exit(1);
      }
    } else {
      // Auto-detect latest Paprika export in iCloud Drive
      const spinner = ora('Looking for Paprika exports in iCloud Drive…').start();
      try {
        const latest = await findLatestPaprikaExport();
        if (!latest) {
          spinner.fail('No Paprika exports found in iCloud Drive.');
          console.log(chalk.dim(`\nLooked in: ${getDefaultICloudPath()}`));
          console.log(chalk.dim('Export your recipes from Paprika 3 → File → Export → All Recipes'));
          console.log(chalk.dim('Then re-run, or use: recipe-context build -i <path>'));
          process.exit(1);
        }
        spinner.succeed(
          `Found: ${chalk.cyan(latest.name)} ${chalk.dim(`(${latest.date.toLocaleDateString()})`)}`
        );
        inputPath = latest.path;
      } catch (err) {
        spinner.fail('Failed to scan iCloud Drive.');
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    }

    const outputPath = resolve(options.output);

    const buildSpinner = ora('Starting build...').start();

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
          buildSpinner.text = `[${progress.phase}] ${progress.message}`;
        }
      );

      buildSpinner.succeed('Build complete!');

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
      buildSpinner.fail('Build failed');
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

// ============================================================================
// ASK Command — natural language recipe search via OpenAI
// ============================================================================

program
  .command('ask')
  .description('Find recipes using natural language (requires OpenAI API key)')
  .argument('<query>', 'Natural language query, e.g. "5 low-calorie high-protein recipes kids would like"')
  .option('-d, --data <path>', 'Path to recipe data folder', './dist/recipe-context')
  .option('-k, --api-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
  .option('-m, --model <model>', 'OpenAI model to use (default: gpt-4o-mini)', 'gpt-4o-mini')
  .option('-v, --verbose', 'Show verbose output including token usage and cost')
  .addHelpText('after', `
Examples:
  $ recipe-context ask "5 low-calorie high-protein recipes kids would like. one chicken, one beef, one pork, one veggie, one mexican"
  $ recipe-context ask "quick weeknight dinners under 30 minutes, nothing spicy" --model gpt-4o
  $ recipe-context ask "Sunday meal prep ideas that freeze well" -d ./my-recipes

Environment:
  OPENAI_API_KEY   Set this instead of passing --api-key each time.

Cost:
  Uses gpt-4o-mini by default (~$0.15/1M input tokens).
  A typical query with 1 000 recipes costs less than $0.01.
`)
  .action(async (query: string, options) => {
    const dataPath = resolve(options.data);

    if (!existsSync(join(dataPath, 'catalog.selection.jsonl'))) {
      console.error(chalk.red(`Error: No recipe data found at ${dataPath}`));
      console.log(chalk.dim('Run "recipe-context build" first to generate the data.'));
      process.exit(1);
    }

    console.log(chalk.bold('\n🤖 Recipe Search\n'));
    console.log(chalk.dim(`Query: ${query}\n`));

    const spinner = ora('Asking AI…').start();

    try {
      // Capture console.log output after spinner stops
      spinner.stop();

      await askRecipes(query, {
        apiKey: options.apiKey,
        model: options.model,
        dataPath,
        verbose: options.verbose,
      });
    } catch (err) {
      spinner.fail('Search failed');
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${msg}`));
      if (msg.includes('API key')) {
        console.log(chalk.dim('\nTip: export OPENAI_API_KEY=sk-... and try again.'));
      }
      process.exit(1);
    }
  });

// ============================================================================
// PLAN Command — deterministic weekly meal plan via optimizer + AI query parser
// ============================================================================

program
  .command('plan')
  .description('Build a weekly meal plan from natural language (deterministic optimizer, AI parses intent only)')
  .argument('<query>', 'Planning query, e.g. "1 chicken, 1 pork, 1 beef, 1 vegetarian, kid friendly, high protein"')
  .option('-d, --data <path>', 'Path to recipe data folder', './dist/recipe-context')
  .option('-k, --api-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
  .option('-m, --model <model>', 'OpenAI model to use for query parsing', 'gpt-4o-mini')
  .option('-v, --verbose', 'Show score breakdowns and candidate counts')
  .option('--json', 'Output full plan result as JSON instead of markdown')
  .option('--max-candidates <n>', 'Max candidates per slot for beam search (default: 75)', parseInt, 75)
  .option('--no-ai-parser', 'Use offline regex parser only (no OpenAI API call for query parsing)')
  .option('--explain', 'Ask AI to write a brief explanation of the selected plan')
  .option('--save-history', 'Save selected recipes to history so they are skipped in future plans')
  .option('--include-history', 'Include previously-suggested recipes even if they are in history (default: history is excluded)')
  .option('--no-history', 'Alias for --include-history; do not filter history (legacy)')
  .option('--auto-enrich', 'Enrich candidate recipes before scoring (calls OpenAI for missing metadata)')
  .option('--auto-enrich-selected', 'Enrich only selected recipes after initial plan, then re-score (default)')
  .option('--no-auto-enrich', 'Never call OpenAI for enrichment during planning')
  .option('--enrichment-limit <n>', 'Max enrichment API calls per planning run (default: 20)', parseInt, 20)
  .addHelpText('after', `
Architecture:
  1. AI (or offline parser) converts your query into structured constraints.
  2. A deterministic TypeScript optimizer selects real recipes from your catalog.
  3. No hallucinated recipes — all IDs are verified against local data.
  4. AI may optionally explain the result but cannot change recipe selections.

Auto-enrichment:
  By default (--auto-enrich-selected), selected recipes missing metadata are enriched
  after the initial plan is built. Results are cached in recipes.enrichment.jsonl.
  Estimated macros are used for soft scoring only — never for strict validation.

Examples:
  $ recipe-context plan "1 chicken, 1 pork, 1 beef, 1 vegetarian — kid friendly, high protein, freeze and reheat"
  $ recipe-context plan "weekly plan: high protein, low fat, at least one HelloFresh, one pasta dish" --verbose
  $ recipe-context plan "meal prep ideas, prefer lentils and black beans" --no-ai-parser
  $ recipe-context plan "..." --auto-enrich --enrichment-limit 10
  $ recipe-context plan "..." --no-auto-enrich

Environment:
  OPENAI_API_KEY   Used for query parsing, enrichment, and (if --explain) plan explanation.
`)
  .action(async (query: string, options) => {
    const dataPath = resolve(options.data);
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

    if (!existsSync(join(dataPath, 'catalog.selection.jsonl'))) {
      console.error(chalk.red(`Error: No recipe data found at ${dataPath}`));
      console.log(chalk.dim('Run "recipe-context build" first to generate the data.'));
      process.exit(1);
    }

    // Determine auto-enrich mode from CLI flags
    // --no-auto-enrich wins over --auto-enrich-selected which wins over --auto-enrich
    let autoEnrich: 'off' | 'selected_only' | 'candidates' = 'selected_only';
    if (options['no-auto-enrich']) {
      autoEnrich = 'off';
    } else if (options.autoEnrich) {
      autoEnrich = 'candidates';
    } else if (options.autoEnrichSelected === false) {
      autoEnrich = 'off'; // explicit --no-auto-enrich-selected (commander default behavior)
    }

    console.log(chalk.bold('\n📅 Weekly Meal Planner\n'));
    console.log(chalk.dim(`Query: ${query}\n`));

    const spinner = ora('Building meal plan…').start();

    try {
      const output = await planRecipes(query, {
        apiKey,
        model: options.model,
        dataPath,
        verbose: options.verbose,
        json: options.json,
        maxCandidatesPerSlot: options.maxCandidates,
        noAiParser: options['no-ai-parser'],
        explain: options.explain,
        // History is excluded by default.
        // Commander.js: --include-history → options.includeHistory
        //               --no-history     → options.history === false (negation flag)
        excludeHistory: !options.includeHistory && options.history !== false,
        saveHistory: false, // CLI owns saving — either silently (--save-history) or after interactive prompt
        autoEnrich,
        enrichmentLimit: options.enrichmentLimit ?? 20,
        useEstimatedMacrosForSoftScoring: true,
      });

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(output.result, null, 2));
        return;
      }

      // Verbose pre-output
      if (options.verbose) {
        console.log(chalk.bold('Parsed Request:'));
        console.log(chalk.dim(JSON.stringify(output.parsedRequest, null, 2)));
        console.log();

        if (output.usedFallback) {
          console.log(chalk.yellow('⚠ Used offline parser (AI parser unavailable or failed)'));
        } else {
          console.log(chalk.green('✓ Query parsed by AI'));
        }

        if (output.parseWarnings.length > 0) {
          for (const w of output.parseWarnings) {
            console.log(chalk.yellow(`  ⚠ ${w}`));
          }
        }
        console.log();

        // History exclusion report
        const he = output.historyExclusion;
        if (he) {
          console.log(chalk.bold('History:'));
          console.log(chalk.dim(`  Path:    ${he.historyPath}`));
          console.log(chalk.dim(`  Entries: ${he.historyCount}`));
          console.log(chalk.dim(`  Exclude: enabled`));
          if (he.excludedCount > 0) {
            console.log(chalk.dim(`  Excluded ${he.excludedCount} recipe(s):`));
            for (const ex of he.excluded) {
              console.log(chalk.dim(`    – ${ex.title} (${ex.id}) — matched by ${ex.matchType}`));
            }
          } else {
            console.log(chalk.dim('  No catalog recipes matched history entries.'));
          }
          console.log();
        }
      }

      // Print the markdown plan
      console.log(output.markdown);

      // AI explanation (appended below the plan)
      if (output.aiExplanation) {
        console.log('\n' + chalk.bold('💬 AI Explanation') + '\n');
        console.log(output.aiExplanation);
      }

      // Validation summary — structural and nutrition are separate
      const { validation } = output.result;
      if (!validation.structuralConstraintsSatisfied) {
        console.log(chalk.yellow('\n⚠ Structural constraints not fully satisfied:'));
        for (const fc of validation.failedConstraints.filter((c) => !c.startsWith('nutrition_target:'))) {
          console.log(chalk.dim(`  • ${fc}`));
        }
      } else {
        console.log(chalk.green('\n✅ Structural constraints satisfied.'));
      }

      const { nutritionEvaluationStatus } = validation;
      if (nutritionEvaluationStatus === 'met') {
        console.log(chalk.green('✅ Macro targets met.'));
      } else if (nutritionEvaluationStatus === 'failed') {
        console.log(chalk.red('❌ Macro targets not met by available real nutrition data.'));
        for (const fc of validation.failedConstraints.filter((c) => c.startsWith('nutrition_target:'))) {
          console.log(chalk.dim(`  • ${fc.replace('nutrition_target:', '')}`));
        }
      } else if (nutritionEvaluationStatus === 'partial') {
        console.log(chalk.yellow('⚠️  Nutrition targets partially evaluated — limited macro data available.'));
      }

      console.log(chalk.dim(`\nPlan score: ${output.result.planScore.toFixed(2)}`));
      console.log(chalk.dim(`Recipes: ${output.result.selectedRecipes.length} selected from local catalog`));
      console.log();

      // ---- History saving: explicit flag or interactive prompt ----
      const recipesToSave = output.result.selectedRecipes.map((r) => ({ id: r.id, title: r.title }));

      if (options.saveHistory) {
        // Explicit --save-history: save without prompting
        await appendToHistory(dataPath, recipesToSave);
        console.log(chalk.dim('Saved to history. These recipes will be skipped in future plans.'));
        console.log(chalk.dim('Use --include-history to override, or "recipe-context history" to review entries.'));
        console.log();
      } else if (process.stdout.isTTY) {
        // Interactive: ask the user
        const answer = await new Promise<string>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question(chalk.cyan('Save these recipes to history? [y/N] '), (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });
        if (answer === 'y' || answer === 'yes') {
          await appendToHistory(dataPath, recipesToSave);
          console.log(chalk.dim('Saved. These recipes will be skipped in future plans.'));
          console.log(chalk.dim('Use --include-history to override, or "recipe-context history" to review entries.'));
        } else {
          console.log(chalk.dim('Not saved. Run with --save-history to save without prompting.'));
        }
        console.log();
      } else {
        // Non-TTY (piped/scripted): don't prompt, don't save
        console.log(chalk.dim('History not updated. Use --save-history to save without prompting.'));
        console.log();
      }

    } catch (err) {
      spinner.fail('Plan failed');
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${msg}`));
      if (msg.includes('API key')) {
        console.log(chalk.dim('\nTip: export OPENAI_API_KEY=sk-... or use --no-ai-parser to skip AI query parsing.'));
      }
      process.exit(1);
    }
  });

// ============================================================================
// HISTORY Command — review and manage previously-suggested recipes
// ============================================================================

program
  .command('history')
  .description('View and manage recipes that have been suggested by the planner')
  .option('-d, --data <path>', 'Path to recipe data folder', './dist/recipe-context')
  .option('--remove <text>', 'Remove entries whose title contains <text> (case-insensitive)')
  .option('--clear', 'Remove all history entries')
  .addHelpText('after', `
The history file is stored at <data>/plan-history.json.
You can also edit it by hand — each entry is a JSON object with id, title, and suggestedAt.
Deleting an entry lets that recipe appear in future plans again.

Examples:
  $ recipe-context history
  $ recipe-context history --remove "chicken stir fry"
  $ recipe-context history --clear
`)
  .action(async (options) => {
    const dataPath = resolve(options.data);
    const entries = await loadHistory(dataPath);

    if (options.clear) {
      await saveHistory(dataPath, []);
      console.log(chalk.green(`\n✅ Cleared ${entries.length} history ${entries.length === 1 ? 'entry' : 'entries'}.\n`));
      return;
    }

    if (options.remove) {
      const needle = (options.remove as string).toLowerCase();
      const kept = entries.filter((e) => !e.title.toLowerCase().includes(needle));
      const removed = entries.length - kept.length;
      if (removed === 0) {
        console.log(chalk.yellow(`\nNo entries matched "${options.remove}".\n`));
        return;
      }
      await saveHistory(dataPath, kept);
      console.log(chalk.green(`\n✅ Removed ${removed} ${removed === 1 ? 'entry' : 'entries'} matching "${options.remove}".\n`));
      return;
    }

    // Default: list all entries
    if (entries.length === 0) {
      console.log(chalk.dim('\nNo plan history yet. Run "recipe-context plan" to build a plan.\n'));
      return;
    }

    console.log(chalk.bold(`\n📋 Plan History (${entries.length} ${entries.length === 1 ? 'recipe' : 'recipes'})\n`));

    const table = new Table({
      head: [chalk.cyan('#'), chalk.cyan('Title'), chalk.cyan('Suggested')],
      style: { head: [], border: [] },
      colWidths: [4, 52, 22],
      wordWrap: true,
    });

    entries.forEach((e, i) => {
      const date = new Date(e.suggestedAt).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
      table.push([(i + 1).toString(), e.title, date]);
    });

    console.log(table.toString());
    console.log(chalk.dim('\nTo remove an entry: recipe-context history --remove "<partial title>"'));
    console.log(chalk.dim('To clear all:        recipe-context history --clear'));
    console.log(chalk.dim('To edit by hand:     open ' + resolve(dataPath, 'plan-history.json') + '\n'));
  });

program.parse();
