/**
 * Report Generator - Creates import statistics and reports
 * Includes ChatGPT Plus loading instructions
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { 
  ImportReport, 
  NormalizedRecipe, 
  DuplicateGroup,
  ParseError,
  MealType,
  PrimaryProtein,
} from './types.js';

export interface ReportData {
  inputPath: string;
  outputPath: string;
  filesScanned: number;
  filesParsed: number;
  filesFailed: number;
  recipes: NormalizedRecipe[];
  duplicateGroups: DuplicateGroup[];
  parseErrors: ParseError[];
  byFormat: Record<string, number>;
}

/**
 * Generate the import report
 */
export async function generateReport(data: ReportData): Promise<ImportReport> {
  const mealTypeCounts = {} as Record<MealType, number>;
  const proteinCounts = {} as Record<PrimaryProtein, number>;
  let totalWeeknightScore = 0;
  let totalKidFriendlyScore = 0;
  let recipesWithIngredients = 0;
  let recipesWithInstructions = 0;

  for (const recipe of data.recipes) {
    mealTypeCounts[recipe.meal_type] = (mealTypeCounts[recipe.meal_type] || 0) + 1;
    proteinCounts[recipe.primary_protein] = (proteinCounts[recipe.primary_protein] || 0) + 1;
    totalWeeknightScore += recipe.weeknight_score;
    totalKidFriendlyScore += recipe.kid_friendly_score;
    if (recipe.ingredients.length > 0) recipesWithIngredients++;
    if (recipe.instructions.length > 0) recipesWithInstructions++;
  }

  const uniqueCount = data.recipes.length - 
    data.duplicateGroups.reduce((sum, g) => sum + g.recipes.length - 1, 0);

  const report: ImportReport = {
    generated_at: new Date().toISOString(),
    input_path: data.inputPath,
    output_path: data.outputPath,
    files_scanned: data.filesScanned,
    files_parsed: data.filesParsed,
    files_failed: data.filesFailed,
    recipes_imported: data.recipes.length,
    recipes_unique: uniqueCount,
    duplicate_groups: data.duplicateGroups,
    parse_errors: data.parseErrors,
    warnings: collectWarnings(data.recipes),
    stats: {
      by_format: data.byFormat,
      by_meal_type: mealTypeCounts,
      by_protein: proteinCounts,
      avg_weeknight_score: data.recipes.length > 0 
        ? totalWeeknightScore / data.recipes.length 
        : 0,
      avg_kid_friendly_score: data.recipes.length > 0 
        ? totalKidFriendlyScore / data.recipes.length 
        : 0,
      recipes_with_ingredients: recipesWithIngredients,
      recipes_with_instructions: recipesWithInstructions,
    },
  };

  return report;
}

/**
 * Collect all warnings from recipes
 */
function collectWarnings(recipes: NormalizedRecipe[]): string[] {
  const warnings: string[] = [];
  
  for (const recipe of recipes) {
    for (const warning of recipe.parse_warnings) {
      warnings.push(`[${recipe.title}] ${warning}`);
    }
  }

  return warnings;
}

/**
 * Write report as markdown
 */
export async function writeReportMarkdown(report: ImportReport, outputPath: string): Promise<void> {
  const lines: string[] = [
    '# Recipe Import Report',
    '',
    `*Generated: ${report.generated_at}*`,
    '',
    '---',
    '',
    '## 📋 Quick Start: Loading into ChatGPT Plus',
    '',
    '### Step 1: Create a New Project',
    '1. Open ChatGPT Plus at https://chatgpt.com',
    '2. Click on "Explore GPTs" in the left sidebar',
    '3. Click "Create" to start a new Project',
    '4. Name it "Recipes" or "Meal Planning"',
    '',
    '### Step 2: Add Project Instructions',
    '1. Copy the contents of `context.project.md`',
    '2. Paste into the "Instructions" field in your Project settings',
    '3. This tells ChatGPT how to use your recipes',
    '',
    '### Step 3: Upload Recipe Data',
    '1. Click "Files" in the Project settings',
    '2. Upload `recipes.normalized.jsonl`',
    '3. This file contains full recipe details (ingredients, instructions)',
    '',
    '### Step 4: Start Using',
    '1. Open your Project and start a new conversation',
    '2. Copy example prompts from `prompt.examples.md`',
    '3. Ask for meal plans, recipe suggestions, etc.',
    '',
    '---',
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Input Path | \`${report.input_path}\` |`,
    `| Output Path | \`${report.output_path}\` |`,
    `| Files Scanned | ${report.files_scanned} |`,
    `| Files Parsed | ${report.files_parsed} |`,
    `| Files Failed | ${report.files_failed} |`,
    `| Recipes Imported | ${report.recipes_imported} |`,
    `| Unique Recipes | ${report.recipes_unique} |`,
    `| Duplicate Groups | ${report.duplicate_groups.length} |`,
    '',
    '## Validation Results',
    '',
  ];

  // Add validation section
  const recipesWithIngredients = report.recipes_imported > 0 
    ? (report.stats.recipes_with_ingredients || 0) / report.recipes_imported 
    : 0;
  const recipesWithInstructions = report.recipes_imported > 0 
    ? (report.stats.recipes_with_instructions || 0) / report.recipes_imported 
    : 0;
  
  lines.push('| Check | Status |');
  lines.push('|-------|--------|');
  lines.push(`| Minimum recipes (≥20) | ${report.recipes_imported >= 20 ? '✅ Pass' : '❌ Fail'} (${report.recipes_imported}) |`);
  lines.push(`| Recipes with ingredients | ${(recipesWithIngredients * 100).toFixed(1)}% |`);
  lines.push(`| Recipes with instructions | ${(recipesWithInstructions * 100).toFixed(1)}% |`);
  lines.push(`| Parse error rate | ${((report.files_failed / report.files_scanned) * 100).toFixed(1)}% |`);
  lines.push('');

  lines.push('## Statistics');
  lines.push('');
  lines.push('### By File Format');
  lines.push('');

  for (const [format, count] of Object.entries(report.stats.by_format)) {
    lines.push(`- **${format || 'unknown'}**: ${count} files`);
  }

  lines.push('');
  lines.push('### By Meal Type');
  lines.push('');

  for (const [type, count] of Object.entries(report.stats.by_meal_type)) {
    lines.push(`- **${type}**: ${count} recipes`);
  }

  lines.push('');
  lines.push('### By Protein');
  lines.push('');

  for (const [protein, count] of Object.entries(report.stats.by_protein)) {
    lines.push(`- **${protein}**: ${count} recipes`);
  }

  lines.push('');
  lines.push('### Scores');
  lines.push('');
  lines.push(`- **Average Weeknight Score**: ${report.stats.avg_weeknight_score.toFixed(2)}`);
  lines.push(`- **Average Kid-Friendly Score**: ${report.stats.avg_kid_friendly_score.toFixed(2)}`);

  // Duplicates section
  if (report.duplicate_groups.length > 0) {
    lines.push('');
    lines.push('## Duplicate Groups');
    lines.push('');
    lines.push('The following recipe groups were identified as potential duplicates:');
    lines.push('');

    for (const group of report.duplicate_groups) {
      lines.push(`### Group: ${group.group_id}`);
      lines.push(`**Canonical Recipe**: ${group.canonical_id}`);
      lines.push('');
      
      for (const recipe of group.recipes) {
        const canonical = recipe.id === group.canonical_id ? ' ✓ (canonical)' : '';
        lines.push(`- **${recipe.title}**${canonical}`);
        lines.push(`  - ID: ${recipe.id}`);
        lines.push(`  - File: \`${recipe.source_file}\``);
        lines.push(`  - Similarity: ${(recipe.similarity_score * 100).toFixed(0)}%`);
      }
      lines.push('');
    }
  }

  // Parse errors
  if (report.parse_errors.length > 0) {
    lines.push('');
    lines.push('## Parse Errors');
    lines.push('');

    for (const error of report.parse_errors) {
      lines.push(`### ${error.file}`);
      lines.push(`\`\`\`\n${error.error}\n\`\`\``);
      lines.push('');
    }
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');

    const maxWarnings = 50;
    const displayWarnings = report.warnings.slice(0, maxWarnings);
    
    for (const warning of displayWarnings) {
      lines.push(`- ${warning}`);
    }

    if (report.warnings.length > maxWarnings) {
      lines.push(`\n*...and ${report.warnings.length - maxWarnings} more warnings*`);
    }
  }

  await writeFile(join(outputPath, 'report.md'), lines.join('\n'));
}
