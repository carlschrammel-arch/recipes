/**
 * Config Loader - Loads user configuration from YAML or JSON
 */

import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import type { UserConfig } from './types.js';

/**
 * Load user config from file
 */
export async function loadUserConfig(configPath: string): Promise<UserConfig> {
  try {
    const content = await readFile(configPath, 'utf-8');
    
    // Determine format based on extension
    if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
      return parseYaml(content) as UserConfig;
    } else {
      return JSON.parse(content) as UserConfig;
    }
  } catch (err) {
    throw new Error(`Failed to load config from ${configPath}: ${err}`);
  }
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): UserConfig {
  return {
    dietary_preferences: {},
    household_notes: {
      kid_friendly: false,
      spice_tolerance: 'medium',
      num_servings: 4,
    },
    excluded_ingredients: [],
    serving_size_default: 4,
    hellofresh_format: false,
    max_recipes_in_context: 500,
    max_chars: 200000,
  };
}

/**
 * Merge user config with defaults
 */
export function mergeConfig(userConfig: Partial<UserConfig>): UserConfig {
  const defaults = getDefaultConfig();
  
  return {
    ...defaults,
    ...userConfig,
    dietary_preferences: {
      ...defaults.dietary_preferences,
      ...userConfig.dietary_preferences,
    },
    household_notes: {
      ...defaults.household_notes,
      ...userConfig.household_notes,
    },
  };
}

/**
 * Create a sample config file content
 */
export function getSampleConfigContent(): string {
  return `# Recipe Context Builder Configuration
# Copy this file to config.yaml and customize

# Dietary preferences - used for tagging and filtering
dietary_preferences:
  high_protein: false
  low_fat: false
  low_carb: false
  vegetarian: false
  vegan: false
  gluten_free: false
  dairy_free: false
  keto: false
  paleo: false

# Household preferences
household_notes:
  kid_friendly: true          # Prioritize kid-friendly recipes
  spice_tolerance: medium     # mild | medium | hot | very_hot
  num_servings: 4             # Default serving size

# Ingredients to exclude/avoid
excluded_ingredients:
  - shellfish
  - peanuts
  # Add more as needed

# Default serving size for scaling
serving_size_default: 4

# Use HelloFresh-style ingredient formatting (quantity first)
hellofresh_format: true

# Context generation settings
max_recipes_in_context: 500   # Maximum recipes in context.project.md
max_chars: 200000             # Maximum characters in context file

# Planning settings — controls the "recipe-context plan" command
planning:
  # When to automatically enrich recipes with missing planning metadata via OpenAI.
  # "off"            — Never call OpenAI during planning. Use local + cached data only.
  # "selected_only"  — Enrich only the 4-6 finally-selected recipes (default, recommended).
  # "candidates"     — Enrich top candidates per slot before scoring (more API calls).
  auto_enrich: selected_only

  # Maximum number of OpenAI enrichment calls per planning run.
  # Prevents runaway API usage when many candidates are missing metadata.
  enrichment_limit_per_plan: 20

  # Use estimated macro grams from enrichment for soft scoring (not strict validation).
  # When true, estimated nutrition improves macro-fit scoring for enriched recipes.
  use_estimated_macros_for_soft_scoring: true

  # Estimated macros are NEVER used for strict validation. This is always false.
  use_estimated_macros_for_strict_validation: false
`;
}
