// agentcity — milestones / landmarks (game-rules §7).
// fireworks (1,000th turn), statue (100th fork), fountain (10th repo),
// plaque (city founding date on Old Town).

import type { LandmarkKind } from "../types.js";

export interface MilestoneFlags {
  fountain: boolean;
  statue: boolean;
  fireworks: boolean;
  plaque: boolean;
}

export interface MilestoneCounters {
  repoCount: number;
  cumForks: number;
  cumTurns: number;
  founded: boolean;
}

/**
 * Return the landmark kinds newly earned this step, mutating `flags`. Order is
 * stable: fountain, statue, fireworks, plaque.
 */
export function newMilestones(
  flags: MilestoneFlags,
  c: MilestoneCounters
): LandmarkKind[] {
  const earned: LandmarkKind[] = [];
  if (!flags.fountain && c.repoCount >= 10) {
    flags.fountain = true;
    earned.push("fountain");
  }
  if (!flags.statue && c.cumForks >= 100) {
    flags.statue = true;
    earned.push("statue");
  }
  if (!flags.fireworks && c.cumTurns >= 1000) {
    flags.fireworks = true;
    earned.push("fireworks-spot");
  }
  if (!flags.plaque && c.founded) {
    flags.plaque = true;
    earned.push("plaque");
  }
  return earned;
}
