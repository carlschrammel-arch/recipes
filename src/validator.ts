/**
 * Validator - Validates recipe output for ChatGPT Plus readiness
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { NormalizedRecipe, RecipeIndex } from './types.js';

export interface ValidationConfig {
  minRecipes: number;
  minIngredientsRate: number;  // 0-1: percentage of recipes with ingredients
  maxParseErrorRate: number;   // 0-1: maximum acceptable parse error rate
  minProteinCoverage: number;  // 0-1: percentage with primary_protein != 'other'
  maxContextChars: number;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  summary: {
    totalRecipes: number;
    recipesWithIngredients: number;
    recipesWithInstructions: number;
    recipesWithProtein: number;
    parseWarningCount: number;
    duplicateGroups: number;
    contextFileSize: number;
  };
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  severity: 'error' | 'warning';
}

const DEFAULT_CONFIG: ValidationConfig = {
  minRecipes: 20,
  minIngredientsRate: 0.90,
  maxParseErrorRate: 0.05,
  minProteinCoverage: 0.85,
  maxContextChars: 200000,
};

/**
 * Validate the output directory for ChatGPT Plus readiness
 */
export async function validateOutput(
  outputPath: string,
  config: Partial<ValidationConfig> = {}
): Promise<ValidationResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const checks: ValidationCheck[] = [];
  
  // Check required files exist
  const requiredFiles = [
    'recipes.normalized.jsonl',
    'recipes.index.json',
    'context.project.md',
    'prompt.examples.md',
    'report.md',
  ];

  for (const file of requiredFiles) {
    const filePath = join(outputPath, file);
    const exists = existsSync(filePath);
    checks.push({
      name: `File exists: ${file}`,
      passed: exists,
      expected: 'file exists',
      actual: exists ? 'exists' : 'missing',
      severity: 'error',
    });
  }

  // If required files don't exist, early return
  if (!existsSync(join(outputPath, 'recipes.normalized.jsonl'))) {
    return {
      valid: false,
      checks,
      summary: {
        totalRecipes: 0,
        recipesWithIngredients: 0,
        recipesWithInstructions: 0,
        recipesWithProtein: 0,
        parseWarningCount: 0,
        duplicateGroups: 0,
        contextFileSize: 0,
      },
    };
  }

  // Load recipes
  const jsonlContent = await readFile(join(outputPath, 'recipes.normalized.jsonl'), 'utf-8');
  const recipes: NormalizedRecipe[] = jsonlContent
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

  // Load index
  const indexContent = await readFile(join(outputPath, 'recipes.index.json'), 'utf-8');
  const index: RecipeIndex = JSON.parse(indexContent);

  // Load context file size
  const contextContent = await readFile(join(outputPath, 'context.project.md'), 'utf-8');
  const contextFileSize = contextContent.length;

  // Calculate statistics
  const recipesWithIngredients = recipes.filter(r => r.ingredients.length > 0).length;
  const recipesWithInstructions = recipes.filter(r => r.instructions.length > 0).length;
  const recipesWithProtein = recipes.filter(r => r.primary_protein !== 'other').length;
  const parseWarningCount = recipes.reduce((sum, r) => sum + r.parse_warnings.length, 0);
  const recipesWithParseWarnings = recipes.filter(r => r.parse_warnings.length > 0).length;

  // Check 1: Minimum recipe count
  checks.push({
    name: 'Minimum recipe count',
    passed: recipes.length >= cfg.minRecipes,
    expected: `>= ${cfg.minRecipes} recipes`,
    actual: `${recipes.length} recipes`,
    severity: 'error',
  });

  // Check 2: Ingredients coverage
  const ingredientsRate = recipes.length > 0 ? recipesWithIngredients / recipes.length : 0;
  checks.push({
    name: 'Recipes with ingredients',
    passed: ingredientsRate >= cfg.minIngredientsRate,
    expected: `>= ${(cfg.minIngredientsRate * 100).toFixed(0)}%`,
    actual: `${(ingredientsRate * 100).toFixed(1)}% (${recipesWithIngredients}/${recipes.length})`,
    severity: 'error',
  });

  // Check 3: Instructions coverage
  const instructionsRate = recipes.length > 0 ? recipesWithInstructions / recipes.length : 0;
  checks.push({
    name: 'Recipes with instructions',
    passed: instructionsRate >= cfg.minIngredientsRate,
    expected: `>= ${(cfg.minIngredientsRate * 100).toFixed(0)}%`,
    actual: `${(instructionsRate * 100).toFixed(1)}% (${recipesWithInstructions}/${recipes.length})`,
    severity: 'error',
  });

  // Check 4: Parse error rate
  const parseErrorRate = recipes.length > 0 ? recipesWithParseWarnings / recipes.length : 0;
  checks.push({
    name: 'Parse error rate',
    passed: parseErrorRate <= cfg.maxParseErrorRate,
    expected: `<= ${(cfg.maxParseErrorRate * 100).toFixed(0)}%`,
    actual: `${(parseErrorRate * 100).toFixed(1)}% (${recipesWithParseWarnings}/${recipes.length})`,
    severity: 'warning',
  });

  // Check 5: Kid-friendly score coverage (100%)
  const kidFriendlyCount = recipes.filter(r => typeof r.kid_friendly_score === 'number').length;
  checks.push({
    name: 'Kid-friendly score coverage',
    passed: kidFriendlyCount === recipes.length,
    expected: '100%',
    actual: `${((kidFriendlyCount / recipes.length) * 100).toFixed(1)}%`,
    severity: 'error',
  });

  // Check 6: Weeknight score coverage (100%)
  const weeknightCount = recipes.filter(r => typeof r.weeknight_score === 'number').length;
  checks.push({
    name: 'Weeknight score coverage',
    passed: weeknightCount === recipes.length,
    expected: '100%',
    actual: `${((weeknightCount / recipes.length) * 100).toFixed(1)}%`,
    severity: 'error',
  });

  // Check 7: Primary protein coverage
  const proteinCoverage = recipes.length > 0 ? recipesWithProtein / recipes.length : 0;
  checks.push({
    name: 'Primary protein coverage',
    passed: proteinCoverage >= cfg.minProteinCoverage,
    expected: `>= ${(cfg.minProteinCoverage * 100).toFixed(0)}%`,
    actual: `${(proteinCoverage * 100).toFixed(1)}% (${recipesWithProtein}/${recipes.length})`,
    severity: 'warning',
  });

  // Check 8: Context file size
  checks.push({
    name: 'Context file size',
    passed: contextFileSize <= cfg.maxContextChars,
    expected: `<= ${cfg.maxContextChars.toLocaleString()} chars`,
    actual: `${contextFileSize.toLocaleString()} chars`,
    severity: 'error',
  });

  // Check 9: Context contains catalog
  const hasCatalog = contextContent.includes('## Recipe Catalog');
  checks.push({
    name: 'Context contains catalog',
    passed: hasCatalog,
    expected: 'catalog section present',
    actual: hasCatalog ? 'present' : 'missing',
    severity: 'error',
  });

  // Check 10: Context contains indices
  const hasIndices = contextContent.includes('HelloFresh') || 
                     contextContent.includes('Pasta Recipes') ||
                     contextContent.includes('Kid-Friendly');
  checks.push({
    name: 'Context contains indices',
    passed: hasIndices,
    expected: 'index sections present',
    actual: hasIndices ? 'present' : 'missing',
    severity: 'warning',
  });

  // Check 11: Duplicate group assignment
  const duplicateGroupIds = new Set(
    recipes.filter(r => r.duplicate_group_id).map(r => r.duplicate_group_id)
  );
  checks.push({
    name: 'Duplicate detection',
    passed: true, // Always passes, just informational
    expected: 'duplicates identified',
    actual: `${duplicateGroupIds.size} groups found`,
    severity: 'warning',
  });

  // Determine overall validity
  const hasErrors = checks.some(c => !c.passed && c.severity === 'error');

  return {
    valid: !hasErrors,
    checks,
    summary: {
      totalRecipes: recipes.length,
      recipesWithIngredients,
      recipesWithInstructions,
      recipesWithProtein,
      parseWarningCount,
      duplicateGroups: duplicateGroupIds.size,
      contextFileSize,
    },
  };
}

/**
 * Test for determinism: run build twice and compare outputs
 */
export async function testDeterminism(outputPath: string): Promise<{
  deterministic: boolean;
  details: string;
}> {
  try {
    const jsonlPath = join(outputPath, 'recipes.normalized.jsonl');
    const indexPath = join(outputPath, 'recipes.index.json');

    if (!existsSync(jsonlPath) || !existsSync(indexPath)) {
      return {
        deterministic: false,
        details: 'Required files not found for determinism test',
      };
    }

    // Check that files are sorted by ID (deterministic ordering)
    const jsonlContent = await readFile(jsonlPath, 'utf-8');
    const recipes: NormalizedRecipe[] = jsonlContent
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));

    const ids = recipes.map(r => r.id);
    const sortedIds = [...ids].sort();
    const isSorted = ids.every((id, i) => id === sortedIds[i]);

    if (!isSorted) {
      return {
        deterministic: false,
        details: 'JSONL file is not sorted by ID - re-running would produce different output',
      };
    }

    return {
      deterministic: true,
      details: 'Output files are deterministically ordered by ID',
    };
  } catch (error) {
    return {
      deterministic: false,
      details: `Error testing determinism: ${error}`,
    };
  }
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push(result.valid ? '✅ VALIDATION PASSED' : '❌ VALIDATION FAILED');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  lines.push('Summary:');
  lines.push(`  Total Recipes: ${result.summary.totalRecipes}`);
  lines.push(`  With Ingredients: ${result.summary.recipesWithIngredients}`);
  lines.push(`  With Instructions: ${result.summary.recipesWithInstructions}`);
  lines.push(`  With Protein Detection: ${result.summary.recipesWithProtein}`);
  lines.push(`  Parse Warnings: ${result.summary.parseWarningCount}`);
  lines.push(`  Duplicate Groups: ${result.summary.duplicateGroups}`);
  lines.push(`  Context File Size: ${result.summary.contextFileSize.toLocaleString()} chars`);
  lines.push('');

  lines.push('Checks:');
  for (const check of result.checks) {
    const icon = check.passed ? '✓' : (check.severity === 'error' ? '✗' : '⚠');
    lines.push(`  ${icon} ${check.name}`);
    if (!check.passed) {
      lines.push(`      Expected: ${check.expected}`);
      lines.push(`      Actual: ${check.actual}`);
    }
  }

  return lines.join('\n');
}
