// agentcity — structure progression (game-rules §3) + decay (§7).

import type { HistoryInfluence } from "../types.js";

// Cumulative WU thresholds per tier (index = tier).
// 0 tent, 1 hut, 2 house, 3 workshop, 4 tower, 5 landmark.
export const TIER_THRESHOLDS = [0, 25, 90, 250, 700, 1800] as const;
export const MAX_TIER = 5;

/** Raw tier from cumulative WU (uncapped). */
export function tierOf(wu: number): number {
  let t = 0;
  for (let i = 1; i < TIER_THRESHOLDS.length; i++) {
    if (wu >= TIER_THRESHOLDS[i]!) t = i;
  }
  return t;
}

/**
 * Tier cap for a history import. Tier 5 landmarks are live-only, so `full`
 * imports cap at Tier 4 (mature town). `capped` keeps the teaser lower (Tier 2)
 * so there is obvious room to grow after founding.
 */
export function tierCapFor(influence: HistoryInfluence): number {
  return influence === "full" ? 4 : 2;
}

/** Effective tier under a cap. */
export function cappedTier(wu: number, cap: number): number {
  return Math.min(tierOf(wu), cap);
}

/**
 * Progress fields for the model lot (renderer contract):
 *   wuIntoTier = wu - TIERS[tier]
 *   wuNextTier = TIERS[tier+1]  (ABSOLUTE threshold; 0 at max tier)
 */
export function tierProgress(wu: number, tier: number): {
  wuIntoTier: number;
  wuNextTier: number;
} {
  const base = TIER_THRESHOLDS[tier] ?? 0;
  const next = TIER_THRESHOLDS[tier + 1];
  return {
    wuIntoTier: wu - base,
    wuNextTier: next === undefined ? 0 : next,
  };
}

/** Decay level from idle days: 0 none, 1 vines (>30d), 2 cracks (>90d). */
export function decayLevel(idleDays: number): 0 | 1 | 2 {
  if (idleDays > 90) return 2;
  if (idleDays > 30) return 1;
  return 0;
}
