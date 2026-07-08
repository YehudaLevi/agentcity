// agentcity — population & street life (game-rules §4). Rolling 7-day windows.

export const CITIZEN_CAP = 24;
export const PET_CAP = 6;
export const WU_PER_CITIZEN = 150;
export const FORKS_PER_PET = 8;
export const SHIP_PER_WU = 500;

/** Sum the trailing 7-day window (inclusive of `day`). */
export function rollingSum(perDay: number[], day: number): number {
  let s = 0;
  for (let d = Math.max(0, day - 6); d <= day; d++) s += perDay[d] ?? 0;
  return s;
}

/** Citizens: 1 per 150 WU in the rolling 7 days (cap 24). */
export function citizensFor(perDayWU: number[], day: number): number {
  return Math.min(CITIZEN_CAP, Math.floor(rollingSum(perDayWU, day) / WU_PER_CITIZEN));
}

/** Pets: 1 per 8 forks in the rolling 7 days (cap 6). */
export function petsFor(perDayForks: number[], day: number): number {
  return Math.min(PET_CAP, Math.floor(rollingSum(perDayForks, day) / FORKS_PER_PET));
}
