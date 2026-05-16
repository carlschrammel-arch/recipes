/**
 * Weekly Meal Planner — Markdown Renderer
 *
 * Renders a WeeklyPlanResult as a human-readable markdown plan.
 * This is the authoritative, hallucination-free renderer.
 *
 * If the optional AI explanation call is used, this renderer's output
 * is compared against the AI version; any new recipe IDs/titles introduced
 * by the AI cause an automatic fallback to this local renderer.
 */

import type { WeeklyPlanResult, CandidateScore, EnrichmentSummary } from './types.js';
import type { NormalizedRecipe } from '../types.js';
import { calculateMacroPercentages } from './macro-calculator.js';
import { computeCheeseScore, describeCheeseScore } from './scoring.js';

// ============================================================================
// Helpers
// ============================================================================

function formatTime(minutes: number | null): string {
  if (minutes === null) return 'time unknown';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Format a recipe's nutrition line with proper handling of partial data.
 * Returns a multi-line string (primary line + optional macro % line).
 */
function formatNutritionLines(recipe: NormalizedRecipe): string[] {
  const n = recipe.nutrition;
  if (!n || n.calories === null) return ['Nutrition: not available'];

  const lines: string[] = [];
  const primaryParts: string[] = [];

  if (n.calories !== null) primaryParts.push(`${Math.round(n.calories)} kcal`);

  const hasProtein = n.protein_g != null;
  const hasCarbs = n.carbs_g != null;
  const hasFat = n.fat_g != null;

  if (hasProtein) primaryParts.push(`${Math.round(n.protein_g!)}g protein`);
  const missingParts: string[] = [];
  if (!hasProtein) missingParts.push('protein');
  if (!hasCarbs) missingParts.push('carbs');
  else primaryParts.push(`${Math.round(n.carbs_g!)}g carbs`);
  if (!hasFat) missingParts.push('fat');
  else primaryParts.push(`${Math.round(n.fat_g!)}g fat`);

  if (missingParts.length > 0) {
    primaryParts.push(`${missingParts.join('/')} not available`);
  }

  lines.push(`Nutrition: ${primaryParts.join(' · ')}`);

  // Macro percentages (only when all three grams are present)
  const macros = calculateMacroPercentages({
    protein_g: n.protein_g,
    carbs_g: n.carbs_g,
    fat_g: n.fat_g,
  });

  if (macros.source === 'macro_calories') {
    lines.push(
      `Macros: ${macros.proteinPct!.toFixed(1)}% protein · ` +
      `${macros.carbsPct!.toFixed(1)}% carbs · ` +
      `${macros.fatPct!.toFixed(1)}% fat`
    );
    // Protein density — useful when comparing recipes across different calorie levels
    if (n.protein_g != null && n.calories != null && n.calories > 0) {
      const density = (n.protein_g / n.calories) * 100;
      lines.push(`Protein density: ${density.toFixed(1)}g protein per 100 kcal`);
    }
  } else if (missingParts.length > 0) {
    lines.push(`Macros: not evaluated — missing ${missingParts.join(' and ')}`);
  }

  return lines;
}

function formatSource(recipe: NormalizedRecipe): string {
  if (recipe.source_url) return `[${recipe.source_name ?? recipe.source_url}](${recipe.source_url})`;
  if (recipe.source_name) return recipe.source_name;
  return '';
}

function formatBadges(recipe: NormalizedRecipe): string {
  const badges: string[] = [];
  if (recipe.kid_friendly_score >= 0.75) badges.push('👶 Kid-friendly');
  if (recipe.weeknight_score >= 0.75) badges.push('⚡ Weeknight');
  if (recipe.cost_tier === 'low') badges.push('💰 Budget');
  else if (recipe.cost_tier === 'medium') badges.push('💰💰 Mid-cost');
  return badges.join(' · ');
}

function slugProtein(slot: string): string {
  // Handle flex_N slot keys (flex_0, flex_1, etc.)
  if (slot === 'flex' || slot.startsWith('flex_')) return '🍽️ Flex';
  const map: Record<string, string> = {
    chicken: '🐓 Chicken',
    beef: '🥩 Beef',
    pork: '🐷 Pork',
    vegetarian: '🥦 Vegetarian',
    vegan: '🌱 Vegan',
    seafood: '🐟 Seafood',
    turkey: '🦃 Turkey',
    flex: '🍽️ Flex',
    other: '🍽️ Other',
  };
  return map[slot] ?? `🍽️ ${slot.charAt(0).toUpperCase() + slot.slice(1)}`;
}

// ============================================================================
// Main render function
// ============================================================================

export interface RenderOptions {
  /** Show per-recipe score breakdowns. */
  verbose?: boolean;
  /** Include shopping overlap section. */
  showShoppingList?: boolean;
  /** Show validation warnings. */
  showWarnings?: boolean;
  /** Show alternatives per slot. */
  showAlternatives?: boolean;
  /** Whether the AI parser was used or the offline fallback. */
  usedAiParser?: boolean;
  /** Whether the offline parser was the fallback. */
  usedFallback?: boolean;
  /** Parse warnings from the query parser. */
  parseWarnings?: string[];
  /** Map from ID to CandidateScore for score display. */
  scoresByRecipeId?: Map<string, CandidateScore>;
  /** Enrichment summary to render at the end of the plan. */
  enrichmentSummary?: EnrichmentSummary;
}

/**
 * Render a WeeklyPlanResult as a markdown string.
 * All recipe information comes from local data — no external content.
 */
export function renderPlanAsMarkdown(
  result: WeeklyPlanResult,
  options: RenderOptions = {}
): string {
  const lines: string[] = [];
  const { request, selectedRecipes, shoppingOverlap, validation, alternatives } = result;

  // Effective slot list: required + flex (using unique flex_N keys to match optimizer)
  const flexSlotKeys = Array.from(
    { length: request.flexMealCount ?? 0 },
    (_, i) => `flex_${i}`
  );
  const effectiveSlots: string[] = [
    ...request.requiredProteinSlots,
    ...flexSlotKeys,
  ];

  // ---- Header ----
  lines.push('# 🗓️ Weekly Meal Plan\n');

  const parserNote = options.usedFallback
    ? '_Query parsed using offline parser (AI parser unavailable or failed)._'
    : '_Query parsed by AI. Recipes selected deterministically from your local catalog._';
  lines.push(parserNote);
  lines.push('');

  if (options.parseWarnings && options.parseWarnings.length > 0) {
    lines.push('> **Parser warnings:**');
    for (const w of options.parseWarnings) {
      lines.push(`> - ${w}`);
    }
    lines.push('');
  }

  // ---- Plan summary ----
  lines.push('## Plan Summary\n');

  for (let i = 0; i < effectiveSlots.length; i++) {
    const slot = effectiveSlots[i];
    const recipe = selectedRecipes[i];
    const label = slugProtein(slot);
    lines.push(recipe
      ? `- **${label}**: ${recipe.title}`
      : `- **${label}**: _(no candidate found)_`
    );
  }

  // Preferred ingredient coverage
  if (result.preferredIngredientCoverage && request.preferredIngredients.length > 0) {
    const cov = result.preferredIngredientCoverage;
    const pct = Math.round(cov.coverageScore * 100);
    if (cov.matched.length > 0) {
      lines.push(`\n**Preferred ingredients covered (${pct}%):** ${cov.matched.join(', ')}`);
    }
    if (cov.missing.length > 0) {
      lines.push(`**Not found in plan:** ${cov.missing.join(', ')}`);
    }
  }

  lines.push('');

  // ---- Request Fit Summary ----
  if (result.requestFitSummary) {
    const fit = result.requestFitSummary;
    const fitEmoji = { excellent: '✨', good: '✅', fair: '⚠️', weak: '❌' }[fit.overallFitLabel];
    lines.push('## Plan Fit Summary\n');
    lines.push(`**Overall fit: ${fitEmoji} ${fit.overallFitLabel.charAt(0).toUpperCase() + fit.overallFitLabel.slice(1)}**\n`);

    if (fit.strongMatches.length > 0) {
      lines.push('**✅ Strong matches:**');
      for (const m of fit.strongMatches) lines.push(`- ${m}`);
      lines.push('');
    }
    if (fit.weakSpots.length > 0) {
      lines.push('**⚠️ Weak spots:**');
      for (const w of fit.weakSpots) lines.push(`- ${w}`);
      lines.push('');
    }
    if (fit.suggestedImprovements.length > 0) {
      lines.push('**💡 Suggested improvements:**');
      for (const s of fit.suggestedImprovements) lines.push(`- ${s}`);
      lines.push('');
    }
  }

  // ---- Plan-average nutrition ----
  const withAllMacros = selectedRecipes.filter(
    (r) => r.nutrition?.protein_g != null && r.nutrition?.carbs_g != null && r.nutrition?.fat_g != null
  );
  const withCalories = selectedRecipes.filter((r) => r.nutrition?.calories != null);
  const withProteinAndCalories = selectedRecipes.filter(
    (r) => r.nutrition?.protein_g != null && r.nutrition?.calories != null && r.nutrition.calories > 0
  );

  if (withCalories.length > 0 || withAllMacros.length > 0) {
    lines.push('### Average Nutrition Per Recipe\n');
    lines.push('_Calories shown per listed serving. Divide any recipe to adjust portion size — macro ratios stay the same regardless of how much you eat._\n');

    const dataCount = Math.max(withCalories.length, withAllMacros.length);
    if (dataCount < selectedRecipes.length) {
      lines.push(`_Based on ${dataCount} of ${selectedRecipes.length} recipes with available data._\n`);
    }

    if (withCalories.length > 0) {
      const avgCal = withCalories.reduce((a, r) => a + r.nutrition!.calories!, 0) / withCalories.length;
      const minCal = Math.min(...withCalories.map((r) => r.nutrition!.calories!));
      const maxCal = Math.max(...withCalories.map((r) => r.nutrition!.calories!));
      if (minCal !== maxCal) {
        lines.push(`- Avg calories: **${Math.round(avgCal)} kcal** (range: ${Math.round(minCal)}–${Math.round(maxCal)} kcal per listed serving)`);
      } else {
        lines.push(`- Avg calories: **${Math.round(avgCal)} kcal** per listed serving`);
      }
    }

    if (withAllMacros.length > 0) {
      // Sum macro grams and use macro-calculator for percentages
      let totalProtG = 0, totalCarbsG = 0, totalFatG = 0;
      for (const r of withAllMacros) {
        totalProtG += r.nutrition!.protein_g!;
        totalCarbsG += r.nutrition!.carbs_g!;
        totalFatG += r.nutrition!.fat_g!;
      }
      const avgMacros = calculateMacroPercentages({
        protein_g: totalProtG / withAllMacros.length,
        carbs_g: totalCarbsG / withAllMacros.length,
        fat_g: totalFatG / withAllMacros.length,
      });
      if (avgMacros.source === 'macro_calories') {
        lines.push(`- Avg protein: **${avgMacros.proteinPct!.toFixed(1)}%**`);
        lines.push(`- Avg carbs: **${avgMacros.carbsPct!.toFixed(1)}%**`);
        lines.push(`- Avg fat: **${avgMacros.fatPct!.toFixed(1)}%**`);
      }
    } else {
      lines.push('- Macro % averages: _not available (macro gram data missing from most recipes)_');
    }

    // Protein density — key nutritional quality metric that's portion-size-independent
    if (withProteinAndCalories.length > 0) {
      const avgDensity =
        withProteinAndCalories.reduce(
          (a, r) => a + (r.nutrition!.protein_g! / r.nutrition!.calories!) * 100,
          0
        ) / withProteinAndCalories.length;
      lines.push(`- Avg protein density: **${avgDensity.toFixed(1)}g protein per 100 kcal** _(portion-size-independent quality signal)_`);
    }

    lines.push('');
  } else {
    lines.push('_Nutrition data not available for the selected recipes._\n');
  }


  // ---- Recipe cards ----
  lines.push('---\n');
  lines.push('## Recipes\n');

  for (let i = 0; i < selectedRecipes.length; i++) {
    const recipe = selectedRecipes[i];
    const slot = effectiveSlots[i] ?? 'flex';

    lines.push(`### ${i + 1}. ${recipe.title}`);
    lines.push(`**Slot:** ${slugProtein(slot)}`);
    lines.push('');

    const source = formatSource(recipe);
    if (source) lines.push(`**Source:** ${source}`);

    lines.push(`**Total time:** ${formatTime(recipe.total_time_minutes)}`);
    if (recipe.yield_servings != null) {
      lines.push(`**Servings:** ${recipe.yield_servings}`);
    }
    lines.push(`**Cost tier:** ${recipe.cost_tier}`);

    const badges = formatBadges(recipe);
    if (badges) lines.push(`**Tags:** ${badges}`);

    // Cheesy fit line (only when cheesy preference was requested)
    if (request.perRecipePreferences?.includes('cheesy')) {
      const cheeseScore = computeCheeseScore(recipe);
      const cheeseDesc = describeCheeseScore(cheeseScore, recipe);
      lines.push(`**Cheesy fit:** ${cheeseDesc}`);
    }

    lines.push('');
    const nutritionLines = formatNutritionLines(recipe);
    for (const nl of nutritionLines) {
      lines.push(`**${nl.startsWith('Macros') ? '' : ''}${nl}**`.replace(/\*\*\*\*/g, '**'));
    }

    if (options.verbose && options.scoresByRecipeId) {
      const cs = options.scoresByRecipeId.get(recipe.id);
      if (cs) {
        lines.push('');
        lines.push('<details><summary>Score breakdown</summary>\n');
        lines.push(`**Total score: ${cs.score.toFixed(2)}**\n`);
        for (const [key, val] of Object.entries(cs.scoreBreakdown)) {
          lines.push(`- ${key}: ${val.toFixed(3)}`);
        }
        if (cs.matchedPreferredIngredients.length > 0) {
          lines.push(`\n**Matched preferred ingredients:** ${cs.matchedPreferredIngredients.join(', ')}`);
        }
        if (cs.missingNutritionFields.length > 0) {
          lines.push(`\n_Missing nutrition fields (excluded from score): ${cs.missingNutritionFields.join(', ')}_`);
        }
        lines.push('\n</details>');
      }
    }

    // Ingredients (first 8)
    if (recipe.ingredients.length > 0) {
      lines.push('');
      lines.push('**Ingredients:**');
      const topIngs = recipe.ingredients.slice(0, 8);
      for (const ing of topIngs) {
        lines.push(`- ${ing.original}`);
      }
      if (recipe.ingredients.length > 8) {
        lines.push(`- _…and ${recipe.ingredients.length - 8} more_`);
      }
    }

    lines.push('');
    lines.push('---\n');
  }

  // ---- Constraint check table ----
  lines.push('## ✅ Constraint Check\n');
  lines.push('| Constraint | Status | Notes |');
  lines.push('|---|:---:|---|');

  // Total recipes
  const expectedCount = request.mealCount;
  const actualCount = selectedRecipes.length;
  lines.push(
    `| ${expectedCount} total recipes | ${actualCount === expectedCount ? '✅' : '⚠️'} | ${actualCount} selected |`
  );

  // Protein slots
  const slotCounts: Record<string, number> = {};
  for (const s of request.requiredProteinSlots) {
    slotCounts[s] = (slotCounts[s] ?? 0) + 1;
  }
  for (const [slot, count] of Object.entries(slotCounts)) {
    const matchingRecipes = selectedRecipes.filter((r, i) =>
      effectiveSlots[i] === slot
    );
    const hasAll = matchingRecipes.length >= count;
    const titleList = matchingRecipes.map((r) => r.title).join(', ') || 'Not filled';
    lines.push(
      `| ${count} ${slot} | ${hasAll ? '✅' : '❌'} | ${titleList} |`
    );
  }

  // Flex meals — show dish-type or cheesy coverage when those constraints are active
  if ((request.flexMealCount ?? 0) > 0) {
    if (request.allMustMatchTerms?.length) {
      // Dish-type constraint: all recipes must match the term(s)
      // Use sel.tags (from SelectionRecord) for matching — same source as the candidate filter.
      const terms = request.allMustMatchTerms;
      const termLabel = terms.join(' + ');
      const flexRecipes = selectedRecipes.slice(request.requiredProteinSlots.length);
      const flexSelTags = result.selectedRecipeSelTags.slice(request.requiredProteinSlots.length);
      const matchCount = flexRecipes.filter((r, j) => {
        const title = r.title.toLowerCase().replace(/-/g, ' ');
        const tags = (flexSelTags[j] ?? r.tags).map((t) => t.toLowerCase().replace(/-/g, ' '));
        return terms.every((term) => title.includes(term.toLowerCase()) || tags.some((tag) => tag.includes(term.toLowerCase())));
      }).length;
      const total = flexRecipes.length;
      const dishStatus = matchCount >= total ? '✅' : matchCount > 0 ? '⚠️' : '❌';
      lines.push(
        `| All ${total} must be ${termLabel} | ${dishStatus} | ${matchCount} of ${total} matched |`
      );
    } else if (request.perRecipePreferences?.includes('cheesy')) {
      const flexRecipes = selectedRecipes.slice(request.requiredProteinSlots.length);
      const cheeseScores = flexRecipes.map((r) => computeCheeseScore(r));
      const meaningfullyCheesy = cheeseScores.filter((s) => s >= 0.4).length;
      const total = flexRecipes.length;
      const cheesyStatus = meaningfullyCheesy >= total ? '✅' : meaningfullyCheesy >= Math.ceil(total * 0.6) ? '⚠️' : '❌';
      lines.push(
        `| Cheesy recipes | ${cheesyStatus} | ${meaningfullyCheesy} of ${total} meaningfully cheesy |`
      );
    } else {
      const flexRecipes = selectedRecipes.slice(request.requiredProteinSlots.length);
      const flexFilled = flexRecipes.length;
      lines.push(
        `| ${request.flexMealCount} flex meal(s) | ${flexFilled >= (request.flexMealCount ?? 0) ? '✅' : '⚠️'} | ${flexRecipes.map((r) => r.title).join(', ') || 'Not filled'} |`
      );
    }
  }

  // Kid-friendly minimum
  if (request.minKidFriendlyMeals) {
    const kfCount = selectedRecipes.filter((r) => r.kid_friendly_score >= 0.6).length;
    const kfOk = kfCount >= request.minKidFriendlyMeals;
    lines.push(
      `| ≥${request.minKidFriendlyMeals} kid-friendly | ${kfOk ? '✅' : '❌'} | ${kfCount} recipes score ≥0.6 |`
    );
  }

  // HelloFresh requirement
  if (request.requiredSourceSignals?.includes('hellofresh')) {
    const hasHF = selectedRecipes.some((r) =>
      (r.source_name ?? '').toLowerCase().includes('hellofresh') ||
      (r.source_url ?? '').toLowerCase().includes('hellofresh')
    );
    lines.push(`| ≥1 HelloFresh | ${hasHF ? '✅' : '❌'} | ${hasHF ? 'Satisfied' : 'No HelloFresh recipe in pool'} |`);
  }

  // Pasta requirement
  if (request.requiredTagsOrTitleTerms?.includes('pasta')) {
    const hasPasta = selectedRecipes.some((r) =>
      r.title.toLowerCase().includes('pasta') ||
      r.tags.includes('pasta') ||
      r.ingredients.some((i) => i.ingredient.toLowerCase().includes('pasta'))
    );
    lines.push(`| ≥1 pasta recipe | ${hasPasta ? '✅' : '❌'} | ${hasPasta ? 'Satisfied' : 'No pasta recipe in pool'} |`);
  }

  // Cuisine requirements
  const cuisineRequirements = (request.requiredTagsOrTitleTerms ?? [])
    .filter((t) => t.startsWith('cuisine:'))
    .map((t) => t.slice('cuisine:'.length));
  for (const cuisine of cuisineRequirements) {
    const match = selectedRecipes.find((r) =>
      (r.cuisine?.toLowerCase().includes(cuisine)) ||
      r.title.toLowerCase().includes(cuisine) ||
      r.tags.some((tag) => tag.toLowerCase().includes(cuisine))
    );
    lines.push(
      `| ≥1 ${cuisine} recipe | ${match ? '✅' : '❌'} | ${match ? match.title : `No ${cuisine} recipe found`} |`
    );
  }

  // anyDishTypes (OR logic — each recipe must match at least one)
  if (request.anyDishTypes?.length) {
    const terms = request.anyDishTypes;
    const termLabel = terms.join(' or ');
    const matchCount = selectedRecipes.filter((r, i) => {
      const title = r.title.toLowerCase();
      const selTags = (result.selectedRecipeSelTags[i] ?? r.tags).map((t) => t.toLowerCase());
      return terms.some((term) => title.includes(term.toLowerCase()) || selTags.some((tag) => tag.includes(term.toLowerCase())));
    }).length;
    const total = selectedRecipes.length;
    const status = matchCount >= total ? '✅' : matchCount > 0 ? '⚠️' : '❌';
    lines.push(`| All must be ${termLabel} | ${status} | ${matchCount} of ${total} matched |`);
  }

  // requiredIngredientTerms
  if (request.requiredIngredientTerms?.length) {
    for (const ing of request.requiredIngredientTerms) {
      const matchCount = selectedRecipes.filter((r) => {
        const ingText = r.ingredients.map((i) => (i.ingredient + ' ' + i.original).toLowerCase()).join(' ');
        return ingText.includes(ing.toLowerCase()) || r.title.toLowerCase().includes(ing.toLowerCase());
      }).length;
      const total = selectedRecipes.length;
      const status = matchCount >= total ? '✅' : matchCount > 0 ? '⚠️' : '❌';
      lines.push(`| All must contain "${ing}" | ${status} | ${matchCount} of ${total} matched |`);
    }
  }

  // minSpiceLevel
  if (request.minSpiceLevel != null) {
    const spiceLabels = ['not spicy', 'mild', 'medium', 'hot', 'very hot', 'extreme'];
    const label = spiceLabels[request.minSpiceLevel] ?? `≥${request.minSpiceLevel}`;
    const matchCount = selectedRecipes.filter((r) => (r.spice_level ?? 0) >= request.minSpiceLevel!).length;
    const total = selectedRecipes.length;
    const status = matchCount >= total ? '✅' : matchCount > 0 ? '⚠️' : '❌';
    lines.push(`| All must be ≥${label} spicy | ${status} | ${matchCount} of ${total} recipes qualify |`);
  }

  // Macro targets
  if (request.macroTargets) {
    const { nutritionEvaluationStatus, nutritionTargetsSatisfied } = validation;
    let macroStatus: string;
    let macroNotes: string;

    switch (nutritionEvaluationStatus) {
      case 'met':
        macroStatus = '✅';
        macroNotes = 'All macro targets within range';
        break;
      case 'failed':
        macroStatus = '❌';
        macroNotes = (validation.macroFailedTargets ?? []).join('; ') ||
          validation.failedConstraints
            .filter((c) => c.startsWith('nutrition_target:'))
            .map((c) => c.replace('nutrition_target:', ''))
            .join('; ') ||
          'Targets not met';
        break;
      case 'partial':
        macroStatus = '⚠️';
        {
          const partialDetails = (validation.macroFailedTargets ?? []).join('; ');
          macroNotes = `Partially evaluated; ${withAllMacros.length} of ${selectedRecipes.length} recipes had complete macro data${partialDetails ? `: ${partialDetails}` : ''}`;
        }
        break;
      default:
        macroStatus = '—';
        macroNotes = 'No macro targets requested or no data';
    }
    lines.push(`| Macro targets | ${macroStatus} | ${macroNotes} |`);
  }

  lines.push('');

  // ---- Shopping overlap ----
  if (options.showShoppingList !== false) {
    const { sharedIngredients, pantryOverlaps, estimatedWasteRisk, notes } = shoppingOverlap;

    lines.push('## 🛒 Shopping Overlap\n');
    lines.push(`**Waste risk estimate:** ${estimatedWasteRisk.toUpperCase()}\n`);

    for (const note of notes) {
      lines.push(`_${note}_`);
    }
    lines.push('');

    if (sharedIngredients.length > 0) {
      lines.push('Ingredients used in **2+ recipes** — buy once, use across the week:');
      lines.push('');
      const topShared = sharedIngredients.slice(0, 15);
      for (const { ingredient, recipeIds, wasteClass } of topShared) {
        const classLabel = wasteClass === 'perishable' ? '🔴 ' : wasteClass === 'specialty' ? '🟡 ' : '';
        lines.push(`- ${classLabel}**${ingredient}** (${recipeIds.length} recipes)`);
      }
      if (sharedIngredients.length > 15) {
        lines.push(`- _…and ${sharedIngredients.length - 15} more_`);
      }
      lines.push('');
    } else {
      lines.push('_No meaningful ingredient overlap between selected recipes._\n');
    }

    if (options.verbose && pantryOverlaps.length > 0) {
      lines.push(
        `_Pantry overlaps (not counted in waste score): ${pantryOverlaps.map((p) => p.ingredient).join(', ')}_\n`
      );
    }
  }

  // ---- Alternatives ----
  if (options.showAlternatives !== false && alternatives.length > 0) {
    lines.push('## 🔄 Alternative Options\n');
    lines.push('_Next-best candidates per slot (validated from your local catalog):_\n');

    for (const alt of alternatives) {
      lines.push(`**${slugProtein(alt.slot)} alternatives:**`);
      for (const entry of alt.entries.slice(0, 3)) {
        lines.push(`- ${entry.title} (\`${entry.id}\`) — ${entry.reason}`);
      }
      lines.push('');
    }
  }

  // ---- Suggested swaps ----
  if (result.suggestedSwaps && result.suggestedSwaps.length > 0) {
    lines.push('## 🔀 Suggested Swaps\n');
    lines.push('_Targeted replacements that would improve plan-goal alignment:_\n');
    for (const swap of result.suggestedSwaps) {
      lines.push(`**Swap out:** ${swap.replaceTitle}`);
      lines.push(`**Swap in:** ${swap.replacementTitle} (\`${swap.replacementRecipeId}\`)`);
      lines.push(`**Why:** ${swap.reasons.join('; ')}`);
      if (swap.scoreDelta > 0) {
        lines.push(`**Score improvement:** +${swap.scoreDelta.toFixed(2)}`);
      }
      lines.push('');
    }
  }

  // ---- Validation status ----
  if (options.showWarnings !== false) {
    // Structural constraints
    if (validation.structuralConstraintsSatisfied) {
      lines.push('✅ Structural constraints satisfied.\n');
    } else {
      lines.push('## ❌ Structural Constraint Violations\n');
      for (const fc of validation.failedConstraints.filter((c) => !c.startsWith('nutrition_target:'))) {
        lines.push(`- \`${fc}\``);
      }
      lines.push('');
    }

    // Nutrition evaluation (separated from structural)
    const { nutritionEvaluationStatus } = validation;
    if (nutritionEvaluationStatus === 'met') {
      lines.push('✅ Macro targets met.\n');
    } else if (nutritionEvaluationStatus === 'partial') {
      lines.push(
        `⚠️ Macro targets partially evaluated: ${withAllMacros.length} of ${selectedRecipes.length} recipes had complete macro data.\n`
      );
    } else if (nutritionEvaluationStatus === 'failed') {
      lines.push('❌ Macro targets not met:');
      for (const fc of validation.failedConstraints.filter((c) => c.startsWith('nutrition_target:'))) {
        lines.push(`- ${fc.replace('nutrition_target:', '')}`);
      }
      lines.push('');
    }

    // General warnings
    const generalWarnings = validation.warnings;
    if (generalWarnings.length > 0) {
      lines.push('## ⚠️ Warnings\n');
      for (const w of generalWarnings) {
        lines.push(`- ${w}`);
      }
      lines.push('');
    }
  }

  // ---- Enrichment summary ----
  if (options.enrichmentSummary) {
    const e = options.enrichmentSummary;
    lines.push('## 🔬 Enrichment\n');

    if (e.apiKeyMissing) {
      lines.push('_Enrichment skipped: no OpenAI API key found. Using local data and cached enrichment only._');
    } else if (e.recipesEnriched > 0 || e.recipesFromCache > 0) {
      // Use the correct label based on mode
      const recipeLabel = e.mode === 'candidates' ? 'candidate' : 'selected';

      if (e.recipesEnriched > 0) {
        const n = e.recipesEnriched;
        lines.push(`Enrichment: ${n} ${recipeLabel} ${n === 1 ? 'recipe' : 'recipes'} enriched automatically and cached.`);
      }
      if (e.recipesFromCache > 0) {
        const n = e.recipesFromCache;
        lines.push(`${n} ${recipeLabel} ${n === 1 ? 'recipe' : 'recipes'} loaded from enrichment cache (no new API calls).`);
      }

      // Separate nutrition fields from other estimated fields
      const nutritionFieldKeys = new Set(['protein_g', 'carbs_g', 'fat_g', 'calories', 'protein_pct', 'carbs_pct', 'fat_pct']);
      const nutritionFields = e.estimatedFields.filter((f) => nutritionFieldKeys.has(f));
      const otherFields = e.estimatedFields.filter((f) => !nutritionFieldKeys.has(f));

      if (nutritionFields.length > 0) {
        lines.push('Estimated nutrition was available for soft scoring only.');
      }
      if (otherFields.length > 0) {
        lines.push(`Estimated metadata used for soft scoring: ${otherFields.join(', ')}.`);
      }
      lines.push('_Estimated nutrition was not used for strict macro validation._');
      if (e.limitReached) {
        lines.push(`_Enrichment limit reached; some candidates still have missing metadata._`);
      }
    } else {
      lines.push('_No recipes needed enrichment (all metadata present or no candidates eligible)._');
    }
    lines.push('');
  }

  // ---- Selected-despite-warnings ----
  if (result.selectedDespiteWarnings && result.selectedDespiteWarnings.length > 0) {
    lines.push('## ⚠️ Weak-Fit Selections\n');
    lines.push('_These recipes were selected despite not being an ideal fit for your goals:_\n');
    for (const item of result.selectedDespiteWarnings) {
      lines.push(`**${item.title}**`);
      for (const reason of item.reasons) {
        lines.push(`- ${reason}`);
      }
      lines.push('');
    }
  }

  // ---- Footer ----
  lines.push('---');
  lines.push(`_Plan score: ${result.planScore.toFixed(2)} · Generated by recipe-context plan · All recipes from local catalog._`);

  return lines.join('\n');
}

// ============================================================================
// AI explanation post-validation
// ============================================================================

/**
 * Validate that an AI-generated explanation does not introduce new recipe IDs or titles.
 * Returns true if the explanation is safe to use; false if it should be discarded.
 *
 * The check is conservative: if ANY string that looks like a recipe ID or title in the
 * explanation doesn't appear in the local plan, we flag it.
 */
export function isAiExplanationSafe(
  aiText: string,
  result: WeeklyPlanResult
): boolean {
  const localIds = new Set(result.selectedRecipeIds);

  // Check for any 16-char hex strings (potential IDs) not in the local set
  const hexMatches = aiText.match(/\b[0-9a-f]{16}\b/g) ?? [];
  for (const match of hexMatches) {
    if (!localIds.has(match)) return false;
  }

  return true;
}
