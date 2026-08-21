/**
 * Relation normalizer for Round 2 template detection
 *
 * Maps raw relation strings to controlled vocabulary.
 * Seeded with patterns observed in Round 1.
 */

// Controlled vocabulary from Round 1
// Order matters - more specific patterns first
const KNOWN_RELATIONS = new Map<RegExp, string>([
  [/fill|filled?|filling/i, 'fill'],
  [/stack|stacked|stacking|pil(e|ed|ing).*reach|reach.*height/i, 'stack_to_reach'],
  [/charge|charged|charging/i, 'charge'],
  [/equal.*energy|same.*energy|energy.*equal/i, 'equal_energy'],
  [/equal.*(mass|weight)|same.*(mass|weight)|(mass|weight).*equal/i, 'equal_mass'],
  [/equal.*volume|same.*volume|volume.*equal/i, 'equal_volume'],
  [/equal.*distance|span|cover|stretch|extend/i, 'equal_distance'],
  [/equal|equals?|match|same/i, 'equal'],  // Generic equal (catch-all)
  [/last|duration|take.*long/i, 'last_as_long_as'],
  [/produce|generate|output/i, 'power'],
]);

/**
 * Normalize a relation string to controlled vocabulary
 *
 * @param relation Raw relation extracted from question
 * @returns Normalized relation string, or 'unknown_<hash>' if no match
 */
export function normalizeRelation(relation: string): string {
  const cleaned = relation.trim().toLowerCase();

  for (const [pattern, normalized] of KNOWN_RELATIONS) {
    if (pattern.test(cleaned)) {
      return normalized;
    }
  }

  // No match - generate a stable unknown key
  // Use first 8 chars of relation as a readable fallback
  const fallback = cleaned.replace(/[^a-z0-9]/g, '_').substring(0, 12);
  return `unknown_${fallback}`;
}

/**
 * Get all known relation types
 */
export function getKnownRelations(): string[] {
  return Array.from(new Set(KNOWN_RELATIONS.values()));
}

/**
 * Check if a normalized relation is unknown (not in controlled vocabulary)
 */
export function isUnknownRelation(normalized: string): boolean {
  return normalized.startsWith('unknown_');
}
