/**
 * Stage 4 — Natural-language synonym resolver + intent classifier.
 *
 * Takes a user question and matches it against the KPI registry's synonym
 * lists, returning the best-matching KPI plus a confidence score. When
 * confidence is low or multiple KPIs match equally well, returns the
 * ambiguities so the UI can render a "Did you mean..." disambiguation card.
 *
 * Uses pure substring matching against the synonym lists in
 * src/lib/ai/kpi-registry.ts. No LLM required — deterministic and fast.
 *
 * Architecture: the registry's synonyms are the single source of truth.
 * To extend recognized phrasings, add to the synonyms array of the
 * relevant KpiDef — not here.
 */

import { KPI_REGISTRY } from "./kpi-registry.mjs";

// ============================================================================
// Confidence threshold — under this, UI shows "Did you mean..."
// ============================================================================

const DISAMBIGUATION_THRESHOLD = 0.55;
/** Ambiguity window: candidates within this fraction of best score are surfaced. */
const AMBIGUITY_WINDOW = 0.2;

// ============================================================================
// Synonym matching
// ============================================================================

/**
 * Normalizes a string for matching: lowercase, trim, collapse whitespace,
 * strip punctuation that shouldn't affect matching.
 */
function normalize(s) {
  return s.toLowerCase().trim().replace(/[?!.,;:]/g, "").replace(/\s+/g, " ");
}

/**
 * Returns the score (0..1) for matching a single synonym against a question.
 *  - 1.0 if synonym appears as a substring of the question
 *  - 0.7 if all synonym tokens appear in the question (out-of-order)
 *  - 0.0 otherwise
 *
 * Longer synonyms are more confident; shorter ones (single words like "yards")
 * are penalized to avoid over-matching.
 */
function scoreSynonym(synonym, normalizedQuestion) {
  const normSyn = normalize(synonym);
  if (!normSyn) return 0;

  // Exact substring match
  if (normalizedQuestion.includes(normSyn)) {
    // Length factor: longer synonym → more confident
    const lengthFactor = Math.min(1.0, normSyn.length / 20);
    return 0.6 + 0.4 * lengthFactor;
  }

  // Token-set match (every word of synonym appears in question)
  const synTokens = normSyn.split(" ").filter((t) => t.length > 1);
  if (synTokens.length === 0) return 0;
  const allMatch = synTokens.every((t) => normalizedQuestion.includes(t));
  if (allMatch) {
    return 0.5 + 0.2 * Math.min(1.0, synTokens.length / 4);
  }

  return 0;
}

/**
 * Scores a KPI def against a question. Returns the best per-synonym score
 * and the synonyms that contributed.
 */
function scoreKpi(
  kpi,
  normalizedQuestion,
) {
  let best = 0;
  const matched = [];

  for (const syn of kpi.synonyms) {
    const s = scoreSynonym(syn, normalizedQuestion);
    if (s > 0) matched.push(syn);
    if (s > best) best = s;
  }

  // Bonus for KPI name appearing in question
  const nameScore = scoreSynonym(kpi.name, normalizedQuestion);
  if (nameScore > best) best = nameScore;
  if (nameScore > 0 && !matched.includes(kpi.name)) {
    matched.push(kpi.name);
  }

  return { score: best, matchedSynonyms: matched };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolves a free-text question to a canonical KPI id, with confidence
 * and ambiguity reporting. Out-of-scope KPIs are excluded from matching.
 */
export function resolveKpi(question) {
  const norm = normalize(question);
  if (!norm) {
    return { matched: null, ambiguities: [], needsDisambiguation: true };
  }

  const inScope = KPI_REGISTRY.filter((k) => !k.outOfScope);
  const scored = inScope
    .map((k) => {
      const { score, matchedSynonyms } = scoreKpi(k, norm);
      return {
        kpiId: k.id,
        kpiName: k.name,
        confidence: score,
        matchedSynonyms,
      };
    })
    .filter((m) => m.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  if (scored.length === 0) {
    return { matched: null, ambiguities: [], needsDisambiguation: true };
  }

  const best = scored[0];
  const ambiguities = scored.slice(1).filter(
    (m) => m.confidence >= best.confidence * (1 - AMBIGUITY_WINDOW),
  );
  const needsDisambiguation =
    best.confidence < DISAMBIGUATION_THRESHOLD || ambiguities.length > 0;

  return { matched: best, ambiguities, needsDisambiguation };
}

/**
 * Classifies the question's intent pattern. Used by the AI to pick the right
 * dashboard layout / tool. Pure pattern matching — no LLM.
 */
export function classifyIntent(question) {
  const norm = normalize(question);

  // "top N ..." pattern
  const topNMatch = norm.match(/\btop\s+(\d+)\s+([a-z ]+?)\s+(?:by|with)\s+([a-z ]+)/);
  if (topNMatch) {
    return {
      pattern: "top_n_by_metric",
      slots: {
        n: parseInt(topNMatch[1], 10),
        dimension: topNMatch[2].trim(),
        metric: topNMatch[3].trim(),
      },
    };
  }

  // "compare X to Y" pattern
  if (/\bcompare\b.+\bto\b|\bversus\b|\bvs\.?\b/.test(norm)) {
    return { pattern: "compare_a_to_b", slots: {} };
  }

  // "avg/max/min ... per day/week/month" pattern
  const outerMatch = norm.match(/\b(avg|average|max|maximum|min|minimum)\s+([a-z ]+?)\s+per\s+(day|week|month)/);
  if (outerMatch) {
    return {
      pattern: "outer_per_period",
      slots: {
        metric: outerMatch[2].trim(),
        grouping: outerMatch[3],
      },
    };
  }

  // "trend over time" — daily/weekly/monthly + last N
  if (/\b(daily|weekly|monthly|trend|over time|last \d+ days)\b/.test(norm)) {
    return { pattern: "trend_over_time", slots: {} };
  }

  // "how many ... ?" — count
  if (/\bhow many\b/.test(norm)) {
    return { pattern: "count_with_condition", slots: {} };
  }

  // "distribution / breakdown / mix"
  if (/\b(distribution|breakdown|mix|by status|by plant|by customer)\b/.test(norm)) {
    return { pattern: "distribution", slots: {} };
  }

  // "above N" / "over N" / "more than N" — anomaly threshold
  const thresholdMatch = norm.match(/\b(?:above|over|more than|greater than)\s+(\d+(?:\.\d+)?)\b/);
  if (thresholdMatch) {
    return {
      pattern: "anomaly_threshold",
      slots: { threshold: parseFloat(thresholdMatch[1]) },
    };
  }

  // "show me / drill into / for project X" — entity drilldown
  if (/\b(show me|drill|for (project|customer|plant|driver|truck))\b/.test(norm)) {
    return { pattern: "entity_drilldown", slots: {} };
  }

  // "total / sum / how much" — total in window
  if (/\b(total|sum|how much)\b/.test(norm)) {
    return { pattern: "total_in_window", slots: {} };
  }

  return { pattern: "unknown", slots: {} };
}

/**
 * Helper that returns the registry's full KpiDef for a matched KPI id.
 * UI / tools.ts uses this to look up the query template after resolution.
 */
export function getKpiDef(kpiId) {
  return KPI_REGISTRY.find((k) => k.id === kpiId);
}
