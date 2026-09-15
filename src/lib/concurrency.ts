/** Preserve input order while bounding independent remote requests. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid concurrency limit');
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index]); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  // All started work settles before returning an error; no orphan writes.
  if (failed) throw failure;
  return results;
}
