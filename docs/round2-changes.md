# Round 2 Changes - P0 Implementation

**Date**: 2026-08-21
**Trigger**: First run (Gemini 2.5 Flash, taycan-macbook seed) died at gen 17 via embedding-based `attractor_state`
**Verdict**: Harness worked, detector measured the wrong thing

## Key Finding

**Groundedness never fired.** Across 51 generations:
- 100% structural parse success
- 100% dimensional validity
- All referents real-world entities
- Zero fabricated constants

The model did not drift into nonsense - it drifted into **tedium**. By gen 25+, every question was "how many [small objects] fill [container]".

## What We're Measuring

Track 1 is measuring **time-to-template-lock**, not time-to-absurdity.

The embedding-based attractor detector (drift < 0.45, stddev < 0.10) couldn't reliably distinguish healthy variation (drift ~0.50) from semantic collapse (drift ~0.44). "Golf balls in a bathtub" vs "sand grains in a pool" are genuinely semantically distant - the embeddings are correct, we were asking the wrong question.

## P0 Changes Implemented

### 1. Schema Changes

**New death causes:**
- `template_lock` - Replaces `attractor_state`. Deterministic detection via relation/template repetition.
- `dimension_collapse` - Dimension entropy < 0.8 bits

**New columns on `questions`:**
```sql
relation_normalized TEXT     -- 'fill', 'equal_mass', 'stack_to_reach', etc
template_signature  TEXT     -- md5(dim_a || relation || dim_b)[0:12]
```

**New columns on `question_evaluations`:**
```sql
relation_repeat_6    INTEGER   -- count of matching relation in last 6
template_share_10    NUMERIC   -- dominant signature share in last 10
dimension_entropy_10 NUMERIC   -- Shannon bits over dimensions in last 10
```

Migration: `0002_fast_wallow.sql`

### 2. Deterministic Detectors

**Replaced embedding-based attractor detection with three deterministic detectors:**

| Detector | Fires when | Death cause | Window |
|---|---|---|---|
| Relation repetition | Same normalized relation in 5 of last 6 gens | `template_lock` | 6 |
| Template dominance | One (dim_a, relation, dim_b) signature owns 60%+ | `template_lock` | 10 |
| Dimension entropy | Shannon entropy over dimensions < 0.8 bits | `dimension_collapse` | 10 |

**Implementation:**
- `packages/gateway/src/relation-normalizer.ts` - Maps raw relations to controlled vocabulary
- `packages/gateway/src/template-detectors.ts` - Three deterministic detectors
- `scripts/evaluate-round2.ts` - Round 2 evaluator using new detectors

### 3. Relation Normalization

Controlled vocabulary seeded from Round 1 patterns:
- `fill` - filling containers
- `equal_mass`, `equal_energy`, `equal_volume`, `equal_distance` - specific comparison types
- `equal` - generic comparison (catch-all)
- `stack_to_reach` - stacking to height
- `charge` - energy charging
- `last_as_long_as` - time duration
- `power` - power output

Unknown relations generate `unknown_<key>` for review.

### 4. Death Generation Definition (§3.3)

Death generation = **first generation of the failing window**, not the generation that triggered detection.

- Relation repeat (6-window): death_gen = trigger_gen - 5
- Template/dimension (10-window): death_gen = trigger_gen - 9

## What We Explicitly Did NOT Do

Per the change list, we **rejected**:
- ❌ Diversity constraints in prompts ("MUST use different template", "AVOID these patterns")
- ❌ Anti-pattern injection mid-chain (intervening to prevent death)
- ❌ Novelty as a scoring criterion (would measure instruction-following, not degradation)
- ❌ Stratified context sampling as default (changes what's being measured)

**The attractor is the phenomenon. We measure it, we do not engineer it away.**

## Embedding Drift: Demoted to Descriptive

Embedding drift (`drift_from_seed`, `drift_from_parent`) remains in the schema and evaluator but is **descriptive only**, not a death trigger.

It still provides:
- Good visual charts (orbit behavior)
- Semantic distance metric
- Supporting evidence for understanding template lock

But it's not reliable enough for deterministic death detection.

## Round 2 Run Plan

### Phase A: Baseline and Variance (n=5)
- 5 runs: Gemini 2.5 Flash, taycan-macbook seed, depth 5
- Using existing `mutate_question v1` (flat spec)
- **Purpose**: Real variance estimate on gen-to-death

### Phase B: Prompt Isolation (n=5)
- Would test v1 vs v2 prompts if there were a v2
- Since current v1 IS the flat spec, Phase B is skipped

### Phase C: Breadth (n=50)
- 25 runs: v1, 5 seeds × 5 replicates, Gemini 2.5 Flash
- 25 runs: v1, 5 seeds × 5 replicates, second model (TBD)
- **Purpose**: Seed-sufficiency test, cross-model comparison

**Estimated cost:** 60 runs × $0.03 ≈ $2

## Open Questions for Round 2

1. **Is template lock universal or model-specific?** If every model funnels to the same template, that's the headline.
2. **Is lock seed-driven?** Does taycan-macbook's "counting flavor" prime enumeration questions?
3. **Does context depth change lock timing?** Test depth = {1, 5, 15}
4. **Does anything reach ungrounded?** If no model fabricates across 50 runs, delete the resolver from critical path.

## Files Changed

**Schema:**
- `packages/db/src/schema.ts` - Added death causes, columns
- `packages/db/migrations/0002_fast_wallow.sql` - Migration

**Detectors:**
- `packages/gateway/src/relation-normalizer.ts` - NEW
- `packages/gateway/src/template-detectors.ts` - NEW

**Evaluator:**
- `scripts/evaluate-round2.ts` - NEW (deterministic detectors)

**Deprecated (embedding-based):**
- `scripts/analyze-attractor-from-db.ts` - Old attractor detector (kept for reference)

## Testing Status

- ✅ Schema migrated
- ✅ Detectors implemented
- ⏳ Round 2 evaluator tested on Round 1 data
- ⏳ Relation normalizer may need tuning (early trigger on gen 5)
- ⏳ Phase A baseline runs (pending)

## Next Steps

1. Tune relation normalizer if needed (check false positive on gen 5)
2. Run Phase A baseline (5 runs)
3. Analyze variance in death generation
4. Proceed to Phase C if variance is acceptable
5. Answer the 4 open questions
