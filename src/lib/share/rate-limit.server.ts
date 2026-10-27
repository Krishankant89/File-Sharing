
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (process.env.NODE_ENV === "production" && (!redisUrl || !redisToken)) {
  throw new Error(
    "Upstash Redis credentials are required in production.",
  );
}

const redis =
  redisUrl && redisToken
    ? new Redis({
        url: redisUrl,
        token: redisToken,
      })
    : null;

const shareRequestLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(150, "1 m"),
      prefix: "peakline:share:requests",
      analytics: false,
    })
  : null;

export async function limitShareRequests(
  clientId: string,
): Promise<{ ok: boolean; retryAfter?: number }> {
  if (!shareRequestLimiter) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Distributed rate limiter is unavailable.");
    }

    // Development only: allow local testing without Redis.
    return { ok: true };
  }

  const result = await shareRequestLimiter.limit(clientId);

  return {
    ok: result.success,
    retryAfter: result.success
      ? undefined
      : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
  };
}
