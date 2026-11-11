/** Caps calls per key: `rate` a second sustained, with room for a burst of `burst`. */
export interface RateLimit {
  rate: number;
  burst: number;
  /** Bounds the keys remembered; the oldest is forgotten first. */
  maxKeys?: number;
}

/** Two calls a second sustained, with room for a burst of thirty, like Go tronc/mcp. */
export const DEFAULT_RATE_LIMIT: RateLimit = { rate: 2, burst: 30, maxKeys: 10_000 };

/** A token bucket per key, the same algorithm as tronc's middleware.Limiter. */
export class Limiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** Builds a limiter for limit. */
  constructor(private readonly limit: RateLimit) {}

  /** Spends a token for key at now; on refusal, returns the seconds to wait as Retry-After. */
  allow(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const bucket = this.buckets.get(key) ?? { tokens: this.limit.burst, at: now };
    this.buckets.delete(key);
    bucket.tokens = Math.min(this.limit.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.limit.rate);
    bucket.at = now;
    const ok = bucket.tokens >= 1;
    if (ok) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > (this.limit.maxKeys ?? DEFAULT_RATE_LIMIT.maxKeys!)) {
      this.buckets.delete(this.buckets.keys().next().value!);
    }
    return { ok, retryAfter: ok ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / this.limit.rate)) };
  }
}
