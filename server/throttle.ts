// An in-memory fixed-window throttle for cheap, high-volume public reads.
//
// Deliberately not backed by KV: a storage-backed limiter would spend more
// storage operations than the read it protects, which is the opposite of what
// this is for. State lives per isolate, so a determined distributed attacker
// gets more than the nominal ceiling. That is an accepted trade: this exists to
// blunt one client hammering the guide, not to meter students precisely.
// Anything that writes data still uses the durable KV limiter.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
const MAX_TRACKED_KEYS = 10000;

export function throttle(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  // Bound memory: drop expired entries once the map grows, and if it is still
  // oversized, clear it rather than let it grow without limit.
  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
    if (windows.size > MAX_TRACKED_KEYS) windows.clear();
  }

  let w = windows.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count++;
  return {
    allowed: w.count <= limit,
    retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
  };
}

// Exposed for tests so one case cannot leak counts into the next.
export function resetThrottle(): void {
  windows.clear();
}

export function readLimit(env: Record<string, string | undefined>): number {
  const n = Number(env.RATE_LIMIT_READS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1500;
}
