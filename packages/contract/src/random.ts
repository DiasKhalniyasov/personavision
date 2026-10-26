/**
 * The seeded random-number generator the whole project samples with, so that the offline
 * deterministic mode is reproducible: the same seed yields the same sequence, in every
 * process and on every platform.
 *
 * mulberry32 — 32-bit integer arithmetic only, so there is no floating-point drift
 * between platforms, and the state is one word.
 */
export const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
};
