import { Redis } from '@upstash/redis';
import { env } from '@/config/env';

let redisInstance: Redis | null = null;

/**
 * Singleton Redis client for hot data (sessions, presence, rate limits).
 */
export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisInstance;
}


