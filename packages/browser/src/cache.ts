/**
 * Content-addressed capture caching.
 *
 * Twelve sessions over the same variant see the same screen twelve times, and a screen is a
 * full-page screenshot: without a cache that is twelve identical PNGs and twelve
 * extractions. The key is built by the caller from the variant URL, the step, the device
 * and the page's content hash (`captureCacheKey` in `capture.ts`), so two pages that differ
 * by a single byte of markup are two captures.
 *
 * **Neutral seam.** Every lookup is a miss and the work runs, so behaviour is correct and
 * merely repeated. The caching ticket of this step fills this file and no other.
 */

export const withCache = async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();
