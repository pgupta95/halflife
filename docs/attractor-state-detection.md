# Attractor State Detection

## Overview

**Attractor state** is a soft death criterion that detects when a model's question generation converges to a repetitive semantic pattern, even if the questions are structurally valid and not literal copies.

This addresses a gap in the original death criteria, which only caught:
- **Hard failures**: `structure_lost`, `degenerate_loop`
- But missed **semantic collapse**: convergence to a stable template

## The Problem

In our first run with Gemini 2.5 Flash, we observed:
- All 50 questions parsed successfully (no `structure_lost`)
- No near-identical copies (drift from parent always > 0.25, well above 0.02 threshold for `degenerate_loop`)
- **But** from gen 17-50, almost every question followed the template: "How many [small objects] to fill [large container]?"

This is an **attractor basin** - the model found a stable pattern and couldn't escape it.

## Detection Criterion

**Attractor state is triggered when:**
- 8 consecutive generations have:
  - Mean drift-from-parent < 0.45
  - Standard deviation of drift-from-parent < 0.10

**Why these thresholds?**
- **Mean < 0.45**: Below the overall average drift (which is ~0.46 across all runs)
- **StdDev < 0.10**: Low variance indicates the model is stuck in a narrow semantic region
- **8 consecutive**: Long enough to distinguish from normal variation, short enough to catch early convergence

## Example Detection

From our Gemini 2.5 Flash run:

```
Gen 17-24: mean=0.4436, stdDev=0.0688  ← ATTRACTOR DETECTED
```

Questions in this window:
- Gen 17: "How many raindrops to fill a bathtub?"
- Gen 18: "How many houseflies equal a human mass?"
- Gen 19: "How many Lego bricks to reach Eiffel Tower height?"
- Gen 20: "How many sheets of paper to reach Empire State Building?"
- Gen 21: "How many pennies to reach ISS altitude?"
- Gen 22: "How many grains of rice to fill a bathtub?"
- Gen 23: "How many water drops to fill Olympic pool?"
- Gen 24: "How many M&Ms to fill a car?"

Pattern: counting/stacking small objects to match large quantities.

## Implementation

### Database Schema

Added `'attractor_state'` to the `death_cause` enum:

```sql
ALTER TYPE "public"."death_cause" ADD VALUE 'attractor_state';
```

### Detection Algorithm

1. For each generation i ≥ 8:
   - Get the last 8 generations (window = [i-7, i])
   - Extract drift-from-parent values
   - Calculate mean and standard deviation
   - If mean < 0.45 AND stddev < 0.10:
     - **Death detected at generation i-7** (§3.3: first of the streak)
     - Record death event with evidence

2. Evidence stored in `death_events.evidence`:
   ```json
   {
     "driftValues": [
       {"gen": 17, "driftFromParent": 0.3799, "driftFromSeed": 0.6315},
       ...
     ],
     "attractorStats": {
       "window": ["question text 1", "question text 2", ...],
       "mean": 0.4436,
       "stdDev": 0.0688
     }
   }
   ```

### Code

See `scripts/analyze-attractor-from-db.ts` for the detection implementation.

Key function:
```typescript
function calculateStats(values: number[]): { mean: number; stdDev: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev };
}

// Scan sliding windows
for (let i = 8; i < questionsData.length; i++) {
  const window = questionsData.slice(i - 7, i + 1); // 8 consecutive
  const driftValues = window.map(q => q.driftFromParent).filter(d => d !== null);

  if (driftValues.length === 8) {
    const stats = calculateStats(driftValues);

    if (stats.mean < 0.45 && stats.stdDev < 0.10) {
      // ATTRACTOR DETECTED at window[0].genIndex
    }
  }
}
```

## Theoretical Basis

This criterion is grounded in the architecture doc's §10 discussion of attractor states:

> "The 'how many X fill Y' basin is particularly sticky because it:
> 1. Preserves dimensional structure (volume/volume, count/volume)
> 2. Maintains referent groundedness (real objects, real containers)
> 3. Has infinite surface variation (swap any object/container pair)
> 4. Provides clear comparison semantics"

**Drift-based detection works because:**
- When stuck in an attractor, questions vary on surface tokens but share deep semantic structure
- Cosine similarity of embeddings captures this - similar meaning = low drift
- Low variance in drift indicates the model isn't exploring; it's orbiting the same concept

## Calibration Notes

**Current thresholds are v1** - may need adjustment after more runs:
- Mean threshold (0.45): Based on single-run empirical data
- StdDev threshold (0.10): Tuned to catch our observed attractor
- Window size (8): Balances early detection vs false positives

**Future calibration considerations:**
- Run on multiple models to establish baselines
- Compare attractor patterns across different seeds
- Consider adaptive thresholds based on overall run statistics

## Comparison to Other Death Criteria

| Criterion | Detects | Threshold | Window Size | Cost |
|-----------|---------|-----------|-------------|------|
| `structure_lost` | Unparseable questions | 2 consecutive parse failures | 2 | Free (parser only) |
| `degenerate_loop` | Near-identical copies | drift < 0.02 | 4 consecutive | Embedding cost |
| `attractor_state` | Semantic convergence | mean drift < 0.45, stddev < 0.10 | 8 consecutive | Embedding cost |

**Attractor state is the most expensive to detect** (requires embeddings for all questions) but catches the most nuanced failure mode.

## Impact on Experiment Economics

With attractor detection:
- Gemini 2.5 Flash: **died at gen 17** instead of surviving 50
- Cost savings: Can stop generating after death (though we ran to 50 for analysis)
- Model ranking becomes meaningful: death generation is a comparable metric

**Per-model survival times** (hypothetical):
- Model A dies at gen 12 (weak prompt following)
- Model B dies at gen 17 (our Gemini result)
- Model C dies at gen 35 (stronger generalization)
- Model D survives 50 (champion model, or we need harder seeds)

This creates a **meaningful leaderboard** for semantic robustness.

## Future Work

1. **Adaptive thresholds**: Calculate mean/stddev from the run's first N generations, then detect anomalies
2. **Multi-dimensional attractor detection**: Check if quantity_a/quantity_b dimensions also converge
3. **Attractor taxonomy**: Classify different types of attractors (fill, stack, compare, etc.)
4. **Escape detection**: If a model breaks out of an attractor, reset the death clock
5. **Cross-model attractor analysis**: Are some attractors universal? Model-specific?

## References

- Architecture doc §10: Attractor states and semantic convergence
- Execution plan §3.4: drift = 1 - cosine_similarity
- First run results: `scripts/archive/degenerate-loop-results.log`
- Detection script: `scripts/analyze-attractor-from-db.ts`
