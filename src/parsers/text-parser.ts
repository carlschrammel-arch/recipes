/**
 * Text Parser - Parses plain text recipe exports
 */

import type { Parser, RawRecipe } from '../types.js';

export const textParser: Parser = {
  name: 'Text Parser',
  extensions: ['.txt'],

  canParse(filePath: string, content?: Buffer): boolean {
    return filePath.toLowerCase().endsWith('.txt');
  },

  async parse(filePath: string, content: Buffer): Promise<RawRecipe[]> {
    const text = content.toString('utf-8');
    const warnings: string[] = [];

    // Try to detect if this is a Paprika text export
    const isPaprikaFormat = detectPaprikaTextFormat(text);

    if (isPaprikaFormat) {
      return [parsePaprikaText(text, filePath, warnings)];
    }

    // Try generic text parsing
    return [parseGenericText(text, filePath, warnings)];
  },
};

function detectPaprikaTextFormat(text: string): boolean {
  // Paprika text exports typically have labeled sections
  const paprikaLabels = [
    /^ingredients:/im,
    /^directions:/im,
    /^source:/im,
    /^prep time:/im,
    /^cook time:/im,
    /^servings:/im,
  ];

  let matches = 0;
  for (const pattern of paprikaLabels) {
    if (pattern.test(text)) {
      matches++;
    }
  }

  return matches >= 2;
}

function parsePaprikaText(text: string, filePath: string, warnings: string[]): RawRecipe {
  const sections = extractSections(text);

  // Title is usually the first non-empty line
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let title = lines[0] || 'Unknown Recipe';
  
  // If first line looks like a label, try to find actual title
  if (/^[a-z]+:/i.test(title)) {
    title = sections['title'] || sections['name'] || 'Unknown Recipe';
  }

  const ingredients = parseIngredientsList(sections['ingredients'] || '');
  const instructions = parseInstructionsList(sections['directions'] || sections['instructions'] || sections['steps'] || '');

  return {
    title: cleanTitle(title),
    source: sections['source'] || sections['from'],
    source_url: extractUrl(sections['source'] || sections['url'] || ''),
    servings: sections['servings'] || sections['yield'] || sections['serves'],
    prep_time: sections['prep time'] || sections['prep'],
    cook_time: sections['cook time'] || sections['cook'],
    total_time: sections['total time'] || sections['time'],
    ingredients,
    instructions,
    categories: parseCategories(sections['categories'] || sections['tags'] || ''),
    notes: sections['notes'] || sections['note'] || sections['description'],
    nutrition: sections['nutrition'] || sections['nutritional information'],
    source_file: filePath,
    source_format: 'txt',
    parse_warnings: warnings,
  };
}

function parseGenericText(text: string, filePath: string, warnings: string[]): RawRecipe {
  const lines = text.split('\n').map(l => l.trim());
  
  // Find title (first non-empty line)
  let title = 'Unknown Recipe';
  let titleIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      title = lines[i];
      titleIndex = i;
      break;
    }
  }

  // Try to identify ingredients and instructions sections
  const ingredients: string[] = [];
  const instructions: string[] = [];
  
  let mode: 'unknown' | 'ingredients' | 'instructions' = 'unknown';
  
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const lower = line.toLowerCase();

    // Detect section headers
    if (/^ingredients?:?$/i.test(line) || lower === 'ingredients') {
      mode = 'ingredients';
      continue;
    }
    if (/^(directions?|instructions?|steps?|method):?$/i.test(line)) {
      mode = 'instructions';
      continue;
    }

    // Add to appropriate section
    if (mode === 'ingredients') {
      if (looksLikeIngredient(line)) {
        ingredients.push(cleanIngredientLine(line));
      } else if (looksLikeInstruction(line)) {
        mode = 'instructions';
        instructions.push(cleanInstructionLine(line));
      }
    } else if (mode === 'instructions') {
      instructions.push(cleanInstructionLine(line));
    } else {
      // Unknown mode - try to classify
      if (looksLikeIngredient(line)) {
        ingredients.push(cleanIngredientLine(line));
        mode = 'ingredients';
      } else if (looksLikeInstruction(line)) {
        instructions.push(cleanInstructionLine(line));
        mode = 'instructions';
      }
    }
  }

  if (ingredients.length === 0 && instructions.length === 0) {
    warnings.push('Could not identify ingredients or instructions sections');
  }

  return {
    title: cleanTitle(title),
    ingredients,
    instructions,
    source_file: filePath,
    source_format: 'txt',
    raw_text: text,
    parse_warnings: warnings,
  };
}

function extractSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  
  // First, extract single-line key: value pairs (like "Source: example.com")
  const singleLinePattern = /^([A-Za-z][A-Za-z ]*?):\s+(.+)$/gm;
  let match;
  while ((match = singleLinePattern.exec(text)) !== null) {
    const label = match[1].toLowerCase().trim();
    const value = match[2].trim();
    // Only save if not already captured by multi-line section
    if (!sections[label]) {
      sections[label] = value;
    }
  }
  
  // Then, match multi-line section headers like "Ingredients:" (colon at end of line, content follows)
  // Use [ ] (space only) not \s to avoid matching across newlines
  const sectionPattern = /^([A-Za-z][A-Za-z ]*?):\s*$/gm;
  const matches: Array<{ label: string; start: number; headerStart: number }> = [];
  
  while ((match = sectionPattern.exec(text)) !== null) {
    matches.push({
      label: match[1].toLowerCase().trim(),
      start: match.index + match[0].length, // Start of content (after the header line)
      headerStart: match.index, // Start of the header itself
    });
  }

  // Extract content for each multi-line section
  for (let i = 0; i < matches.length; i++) {
    const startPos = matches[i].start;
    // End at the start of the next section header, a blank line followed by "Key: Value", or end of text
    let endPos = (i < matches.length - 1) ? matches[i + 1].headerStart : text.length;
    
    // Also stop at blank line followed by single-line Key: Value pattern
    const content = text.slice(startPos, endPos);
    const blankLineMatch = content.match(/\n\n(?=[A-Za-z][A-Za-z ]*?:\s+\S)/);
    if (blankLineMatch && blankLineMatch.index !== undefined) {
      endPos = startPos + blankLineMatch.index;
    }
    
    sections[matches[i].label] = text.slice(startPos, endPos).trim();
  }

  return sections;
}

function parseIngredientsList(text: string): string[] {
  if (!text) return [];
  
  return text
    .split('\n')
    .map(l => cleanIngredientLine(l))
    .filter(Boolean);
}

function parseInstructionsList(text: string): string[] {
  if (!text) return [];
  
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  // Check if instructions are numbered
  const numbered = lines.every(l => /^\d+[\.\)]\s/.test(l) || !l);
  
  if (numbered) {
    return lines.map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
  }
  
  return lines.map(l => cleanInstructionLine(l)).filter(Boolean);
}

function parseCategories(text: string): string[] {
  if (!text) return [];
  
  // Split by comma, semicolon, or newline
  return text
    .split(/[,;\n]/)
    .map(c => c.trim())
    .filter(Boolean);
}

function cleanTitle(title: string): string {
  return title
    .replace(/^recipe[:\s]*/i, '')
    .replace(/^title[:\s]*/i, '')
    .trim();
}

function cleanIngredientLine(line: string): string {
  return line
    .replace(/^[-•*]\s*/, '')  // Remove bullet points
    .replace(/^\d+[\.\)]\s*/, '')  // Remove numbering
    .replace(/^ingredient[:\s]*/i, '')
    .trim();
}

function cleanInstructionLine(line: string): string {
  return line
    .replace(/^[-•*]\s*/, '')
    .replace(/^\d+[\.\)]\s*/, '')
    .replace(/^step\s*\d*[:\s]*/i, '')
    .trim();
}

function extractUrl(text: string): string | undefined {
  const urlMatch = text.match(/https?:\/\/[^\s)]+/);
  return urlMatch ? urlMatch[0] : undefined;
}

function looksLikeIngredient(text: string): boolean {
  const lower = text.toLowerCase();
  
  // Check for measurements
  if (/\d+\s*(\/\d+)?\s*(cup|tbsp|tsp|oz|lb|g|kg|ml|liter|teaspoon|tablespoon|ounce|pound|gram|pinch|dash)/i.test(lower)) {
    return true;
  }
  
  // Check for common ingredient words
  const ingredientWords = ['salt', 'pepper', 'oil', 'butter', 'flour', 'sugar', 'onion', 'garlic', 'chicken', 'beef', 'egg', 'milk', 'water', 'cream', 'cheese'];
  if (ingredientWords.some(w => lower.includes(w)) && text.length < 150) {
    return true;
  }
  
  // Short lines with numbers are likely ingredients
  if (/^\d/.test(text) && text.length < 100) {
    return true;
  }
  
  return false;
}

function looksLikeInstruction(text: string): boolean {
  const lower = text.toLowerCase();
  
  // Starts with action verb
  const actionVerbs = ['add', 'mix', 'stir', 'cook', 'bake', 'heat', 'combine', 'whisk', 'pour', 'slice', 'chop', 'dice', 'preheat', 'let', 'place', 'remove', 'serve', 'season', 'set', 'bring', 'fold', 'reduce', 'simmer', 'boil', 'fry', 'saute', 'roast', 'grill', 'brush', 'spread', 'cover', 'transfer'];
  
  if (actionVerbs.some(v => lower.startsWith(v))) {
    return true;
  }
  
  // Contains cooking keywords and is longer
  const cookingKeywords = ['minutes', 'hours', 'degrees', 'oven', 'pan', 'pot', 'bowl', 'until', 'medium', 'heat', 'stirring'];
  if (cookingKeywords.some(k => lower.includes(k)) && text.length > 30) {
    return true;
  }
  
  return false;
}
