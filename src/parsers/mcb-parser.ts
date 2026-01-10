/**
 * MCB/ZIP Parser - Parses Paprika .paprikarecipe and .paprikarecipes files
 * These are actually gzipped JSON files
 */

import AdmZip from 'adm-zip';
import { gunzipSync } from 'zlib';
import type { Parser, RawRecipe } from '../types.js';

export const mcbParser: Parser = {
  name: 'MCB/ZIP Parser',
  extensions: ['.paprikarecipe', '.paprikarecipes', '.mcb', '.zip'],

  canParse(filePath: string, content?: Buffer): boolean {
    const lower = filePath.toLowerCase();
    
    if (lower.endsWith('.paprikarecipe') || 
        lower.endsWith('.paprikarecipes') || 
        lower.endsWith('.mcb')) {
      return true;
    }

    if (lower.endsWith('.zip') && content) {
      // Check if it's a recipe-related zip
      return filePath.toLowerCase().includes('recipe') || 
             filePath.toLowerCase().includes('paprika');
    }

    // Check for gzip magic bytes
    if (content && content.length >= 2) {
      if (content[0] === 0x1f && content[1] === 0x8b) {
        return true;
      }
      // Check for ZIP magic bytes
      if (content[0] === 0x50 && content[1] === 0x4b) {
        return true;
      }
    }

    return false;
  },

  async parse(filePath: string, content: Buffer): Promise<RawRecipe[]> {
    const warnings: string[] = [];
    const recipes: RawRecipe[] = [];

    try {
      // First, try to decompress as gzip (single .paprikarecipe file)
      if (isGzipped(content)) {
        const decompressed = gunzipSync(content);
        const json = JSON.parse(decompressed.toString('utf-8'));
        recipes.push(parsePaprikaJson(json, filePath, warnings));
        return recipes;
      }

      // Try as ZIP file (multiple recipes in .paprikarecipes or .zip)
      if (isZip(content)) {
        const zip = new AdmZip(content);
        const entries = zip.getEntries();

        for (const entry of entries) {
          if (entry.isDirectory) continue;

          const name = entry.entryName.toLowerCase();
          if (name.endsWith('.paprikarecipe') || name.endsWith('.json')) {
            try {
              let data: Buffer;
              
              // Try to get the entry data
              const entryData = entry.getData();
              
              // Check if entry data is gzipped
              if (isGzipped(entryData)) {
                data = gunzipSync(entryData);
              } else {
                data = entryData;
              }

              const json = JSON.parse(data.toString('utf-8'));
              const recipe = parsePaprikaJson(json, `${filePath}!${entry.entryName}`, warnings);
              recipes.push(recipe);
            } catch (err) {
              warnings.push(`Failed to parse entry ${entry.entryName}: ${err}`);
            }
          }
        }

        return recipes;
      }

      // Try direct JSON parse
      const json = JSON.parse(content.toString('utf-8'));
      if (Array.isArray(json)) {
        for (const item of json) {
          recipes.push(parsePaprikaJson(item, filePath, warnings));
        }
      } else {
        recipes.push(parsePaprikaJson(json, filePath, warnings));
      }

      return recipes;

    } catch (err) {
      warnings.push(`Failed to parse file: ${err}`);
      return [{
        title: 'Parse Error',
        ingredients: [],
        instructions: [],
        source_file: filePath,
        source_format: 'mcb',
        raw_text: content.toString('utf-8', 0, 1000),
        parse_warnings: warnings,
      }];
    }
  },
};

function isGzipped(content: Buffer): boolean {
  return content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
}

function isZip(content: Buffer): boolean {
  return content.length >= 4 && 
         content[0] === 0x50 && content[1] === 0x4b &&
         (content[2] === 0x03 || content[2] === 0x05) &&
         (content[3] === 0x04 || content[3] === 0x06);
}

interface PaprikaRecipeJson {
  uid?: string;
  name?: string;
  ingredients?: string;
  directions?: string;
  description?: string;
  notes?: string;
  nutritional_info?: string;
  servings?: string;
  source?: string;
  source_url?: string;
  prep_time?: string;
  cook_time?: string;
  total_time?: string;
  difficulty?: string;
  rating?: number;
  categories?: string[];
  photo?: string;
  photo_hash?: string;
  photo_large?: string | null;
  scale?: string;
  hash?: string;
  image_url?: string;
  on_favorites?: number | boolean;
  on_grocery_list?: number | boolean;
  created?: string;
  photo_url?: string;
}

function parsePaprikaJson(json: PaprikaRecipeJson, filePath: string, warnings: string[]): RawRecipe {
  // Paprika JSON format
  const title = json.name || json.uid || 'Unknown Recipe';

  // Ingredients are typically newline-separated
  const ingredientsText = json.ingredients || '';
  const ingredients = ingredientsText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  // Directions are also newline-separated
  const directionsText = json.directions || '';
  const instructions = directionsText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.match(/^step\s*\d*$/i)); // Remove bare "Step 1" lines

  // Categories in Paprika
  const categories = json.categories || [];

  return {
    title,
    source: json.source,
    source_url: json.source_url,
    servings: json.servings,
    prep_time: json.prep_time,
    cook_time: json.cook_time,
    total_time: json.total_time,
    ingredients,
    instructions,
    categories,
    notes: json.notes || json.description,
    nutrition: json.nutritional_info,
    rating: json.rating,
    difficulty: json.difficulty,
    image_url: json.photo_url || json.image_url,
    source_file: filePath,
    source_format: 'mcb',
    parse_warnings: warnings,
  };
}

/**
 * JSON Parser - For direct JSON recipe files
 */
export const jsonParser: Parser = {
  name: 'JSON Parser',
  extensions: ['.json'],

  canParse(filePath: string, content?: Buffer): boolean {
    if (!filePath.toLowerCase().endsWith('.json')) {
      return false;
    }
    
    // Make sure it's actually JSON with recipe content
    if (content) {
      try {
        const text = content.toString('utf-8', 0, 500);
        return text.includes('"ingredients"') || 
               text.includes('"directions"') || 
               text.includes('"recipe"') ||
               text.includes('"name"');
      } catch {
        return false;
      }
    }
    
    return true;
  },

  async parse(filePath: string, content: Buffer): Promise<RawRecipe[]> {
    const warnings: string[] = [];
    const recipes: RawRecipe[] = [];

    try {
      const json = JSON.parse(content.toString('utf-8'));

      if (Array.isArray(json)) {
        for (const item of json) {
          recipes.push(parseJsonRecipe(item, filePath, warnings));
        }
      } else if (json.recipes && Array.isArray(json.recipes)) {
        for (const item of json.recipes) {
          recipes.push(parseJsonRecipe(item, filePath, warnings));
        }
      } else {
        recipes.push(parseJsonRecipe(json, filePath, warnings));
      }

      return recipes;
    } catch (err) {
      warnings.push(`Failed to parse JSON: ${err}`);
      return [{
        title: 'Parse Error',
        ingredients: [],
        instructions: [],
        source_file: filePath,
        source_format: 'json',
        raw_text: content.toString('utf-8', 0, 1000),
        parse_warnings: warnings,
      }];
    }
  },
};

function parseJsonRecipe(json: Record<string, unknown>, filePath: string, warnings: string[]): RawRecipe {
  const getString = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const val = json[key];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }
    return undefined;
  };

  const getArray = (keys: string[]): string[] => {
    for (const key of keys) {
      const val = json[key];
      if (Array.isArray(val)) {
        return val.map(v => typeof v === 'string' ? v : String(v)).filter(Boolean);
      }
      if (typeof val === 'string') {
        return val.split('\n').map(l => l.trim()).filter(Boolean);
      }
    }
    return [];
  };

  return {
    title: getString(['name', 'title', 'recipe_name']) || 'Unknown Recipe',
    source: getString(['source', 'author', 'from']),
    source_url: getString(['source_url', 'url', 'link']),
    servings: getString(['servings', 'yield', 'serves']),
    prep_time: getString(['prep_time', 'prepTime', 'prep']),
    cook_time: getString(['cook_time', 'cookTime', 'cook']),
    total_time: getString(['total_time', 'totalTime', 'time']),
    ingredients: getArray(['ingredients', 'ingredient_list']),
    instructions: getArray(['directions', 'instructions', 'steps', 'method']),
    categories: getArray(['categories', 'tags', 'labels']),
    notes: getString(['notes', 'description', 'note']),
    nutrition: getString(['nutritional_info', 'nutrition', 'nutritional_information']),
    source_file: filePath,
    source_format: 'json',
    parse_warnings: warnings,
  };
}
