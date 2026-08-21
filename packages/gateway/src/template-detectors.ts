/**
 * Round 2 deterministic template detectors
 *
 * Replaces embedding-based attractor detection with deterministic metrics
 * based on structural repetition.
 */

import crypto from 'crypto';

export interface QuestionMetrics {
  genIndex: number;
  dimensionA: string;
  dimensionB: string;
  relationNormalized: string;
  templateSignature: string;
}

/**
 * Generate template signature: md5(dimension_a || relation_normalized || dimension_b)
 */
export function generateTemplateSignature(
  dimensionA: string,
  relationNormalized: string,
  dimensionB: string
): string {
  const payload = `${dimensionA}||${relationNormalized}||${dimensionB}`;
  return crypto.createHash('md5').update(payload).digest('hex').substring(0, 12);
}

/**
 * Detector 1: Relation repetition
 * Fires when same normalized relation appears in 5 of the last 6 generations
 */
export function detectRelationRepeat(window: QuestionMetrics[]): {
  detected: boolean;
  count: number;
  relation: string | null;
} {
  if (window.length < 6) {
    return { detected: false, count: 0, relation: null };
  }

  const last6 = window.slice(-6);
  const relationCounts = new Map<string, number>();

  for (const q of last6) {
    const count = relationCounts.get(q.relationNormalized) || 0;
    relationCounts.set(q.relationNormalized, count + 1);
  }

  for (const [relation, count] of relationCounts) {
    if (count >= 5) {
      return { detected: true, count, relation };
    }
  }

  return { detected: false, count: 0, relation: null };
}

/**
 * Detector 2: Template dominance
 * Fires when one (dimension_a, relation, dimension_b) signature owns 60%+ of last 10 gens
 */
export function detectTemplateDominance(window: QuestionMetrics[]): {
  detected: boolean;
  share: number;
  signature: string | null;
  pattern: string | null;
} {
  if (window.length < 10) {
    return { detected: false, share: 0, signature: null, pattern: null };
  }

  const last10 = window.slice(-10);
  const signatureCounts = new Map<string, { count: number; pattern: string }>();

  for (const q of last10) {
    const existing = signatureCounts.get(q.templateSignature);
    if (existing) {
      existing.count++;
    } else {
      signatureCounts.set(q.templateSignature, {
        count: 1,
        pattern: `${q.dimensionA} ${q.relationNormalized} ${q.dimensionB}`
      });
    }
  }

  for (const [signature, { count, pattern }] of signatureCounts) {
    const share = count / 10;
    if (share >= 0.60) {
      return { detected: true, share, signature, pattern };
    }
  }

  return { detected: false, share: 0, signature: null, pattern: null };
}

/**
 * Detector 3: Dimension entropy
 * Fires when Shannon entropy over dimensions in last 10 gens drops below 0.8 bits
 */
export function calculateDimensionEntropy(window: QuestionMetrics[]): {
  entropy: number;
  detected: boolean;
  dominantDimension: string | null;
} {
  if (window.length < 10) {
    return { entropy: 0, detected: false, dominantDimension: null };
  }

  const last10 = window.slice(-10);
  const dimensionCounts = new Map<string, number>();

  // Count both dimension_a and dimension_b occurrences
  for (const q of last10) {
    const countA = dimensionCounts.get(q.dimensionA) || 0;
    dimensionCounts.set(q.dimensionA, countA + 1);

    const countB = dimensionCounts.get(q.dimensionB) || 0;
    dimensionCounts.set(q.dimensionB, countB + 1);
  }

  // Calculate Shannon entropy: H = -Σ(p_i * log2(p_i))
  const total = last10.length * 2; // 20 dimension slots (2 per question)
  let entropy = 0;

  for (const count of dimensionCounts.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Find dominant dimension
  let dominantDimension: string | null = null;
  let maxCount = 0;
  for (const [dimension, count] of dimensionCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominantDimension = dimension;
    }
  }

  const detected = entropy < 0.8;

  return { entropy, detected, dominantDimension };
}

/**
 * Run all detectors on a window
 */
export function runAllDetectors(window: QuestionMetrics[]): {
  relationRepeat: ReturnType<typeof detectRelationRepeat>;
  templateDominance: ReturnType<typeof detectTemplateDominance>;
  dimensionEntropy: ReturnType<typeof calculateDimensionEntropy>;
  anyDetected: boolean;
  primaryCause: 'template_lock' | 'dimension_collapse' | null;
} {
  const relationRepeat = detectRelationRepeat(window);
  const templateDominance = detectTemplateDominance(window);
  const dimensionEntropy = calculateDimensionEntropy(window);

  const anyDetected = relationRepeat.detected || templateDominance.detected || dimensionEntropy.detected;

  // Priority: template_lock (relation or template) over dimension_collapse
  let primaryCause: 'template_lock' | 'dimension_collapse' | null = null;
  if (relationRepeat.detected || templateDominance.detected) {
    primaryCause = 'template_lock';
  } else if (dimensionEntropy.detected) {
    primaryCause = 'dimension_collapse';
  }

  return {
    relationRepeat,
    templateDominance,
    dimensionEntropy,
    anyDetected,
    primaryCause
  };
}
