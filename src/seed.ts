// agentcity — seed derivation + hash/RNG helpers.
//
// Determinism invariant (AGENTS.md rule 2): the compiler NEVER calls
// Date.now()/Math.random(). All "randomness" here is content-addressed: a value
// is a pure function of (seed, context-key). There is no running RNG stream, so
// any re-fold of the same events reproduces the same city, trivially exact.

import { createHash } from "node:crypto";

/** FNV-1a 32-bit hash of a string -> unsigned 32-bit int. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Full SHA-256 hex digest (deterministic; node built-in). */
export function sha256hex(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

/**
 * Derive the stable city seed from machine id + user (both injectable so tests
 * never read a real machine id). Returns a short hex handle used as CityModel.seed.
 */
export function deriveSeed(machineId: string, user: string): string {
  return sha256hex(`agentcity|${machineId}|${user}`).slice(0, 8);
}

/** A float in [0,1) derived purely from (seed, key). */
export function rand(seed: string, key: string): number {
  // 53-bit mantissa from two 32-bit halves of a sha digest for good spread.
  const hex = sha256hex(`${seed}::${key}`);
  const hi = parseInt(hex.slice(0, 8), 16);
  const lo = parseInt(hex.slice(8, 16), 16);
  // combine to [0,1)
  return (hi * 4294967296 + lo) / 18446744073709551616;
}

/** Integer in [0, n) derived from (seed, key). */
export function randInt(seed: string, key: string, n: number): number {
  if (n <= 0) return 0;
  return Math.floor(rand(seed, key) * n) % n;
}

/** Signed jitter in [-mag, +mag] derived from (seed, key). */
export function jitter(seed: string, key: string, mag: number): number {
  return (rand(seed, key) * 2 - 1) * mag;
}

/** hash(repo) style variant number (matches "variant":hash(repo)). */
export function variantOf(seed: string, repo: string): number {
  return fnv1a(`${seed}|${repo}`) % 1000;
}
