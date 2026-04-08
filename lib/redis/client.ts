import { Redis } from '@upstash/redis';
import { env } from '@/config/env';

type SetWithExpireOptions = { ex?: number };

export type RedisLike = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: SetWithExpireOptions): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  scard(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  del(key: string): Promise<number>;
};

class InMemoryRedis implements RedisLike {
  private values = new Map<string, unknown>();
  private sets = new Map<string, Set<string>>();
  private expiresAt = new Map<string, number>();

  private isExpired(key: string): boolean {
    const expires = this.expiresAt.get(key);
    if (!expires) return false;
    if (Date.now() <= expires) return false;
    this.values.delete(key);
    this.sets.delete(key);
    this.expiresAt.delete(key);
    return true;
  }

  private touch(key: string) {
    this.isExpired(key);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.touch(key);
    return (this.values.get(key) as T) ?? null;
  }

  async set(key: string, value: unknown, opts?: SetWithExpireOptions): Promise<'OK'> {
    this.values.set(key, value);
    if (opts?.ex && opts.ex > 0) {
      this.expiresAt.set(key, Date.now() + opts.ex * 1000);
    } else {
      this.expiresAt.delete(key);
    }
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.touch(key);
    const current = Number(this.values.get(key) ?? 0);
    const next = current + 1;
    this.values.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.values.has(key) && !this.sets.has(key)) return 0;
    this.expiresAt.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async scard(key: string): Promise<number> {
    this.touch(key);
    return this.sets.get(key)?.size ?? 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    this.touch(key);
    let set = this.sets.get(key);
    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }
    const before = set.size;
    set.add(member);
    return set.size > before ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const existed = this.values.delete(key) || this.sets.delete(key) ? 1 : 0;
    this.expiresAt.delete(key);
    return existed;
  }
}

let redisInstance: RedisLike | null = null;
let fallbackInstance: InMemoryRedis | null = null;
let hasWarnedFallback = false;

function shouldFallback(err: unknown): boolean {
  const msg =
    err instanceof Error ? `${err.message}` : typeof err === 'string' ? err : '';
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT')
  );
}

function getFallbackRedis(): InMemoryRedis {
  if (!fallbackInstance) {
    fallbackInstance = new InMemoryRedis();
  }
  if (!hasWarnedFallback) {
    hasWarnedFallback = true;
    console.warn(
      '[redis] Upstash unavailable. Using in-memory fallback for local development.'
    );
  }
  return fallbackInstance;
}

function createUpstashAdapter(client: Redis): RedisLike {
  return {
    async get(key) {
      try {
        return await client.get(key);
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().get(key);
        }
        throw err;
      }
    },
    async set(key, value, opts) {
      try {
        return await client.set(key, value, opts as any);
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().set(key, value, opts);
        }
        throw err;
      }
    },
    async incr(key) {
      try {
        return (await client.incr(key)) as number;
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().incr(key);
        }
        throw err;
      }
    },
    async expire(key, seconds) {
      try {
        return (await client.expire(key, seconds)) as number;
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().expire(key, seconds);
        }
        throw err;
      }
    },
    async scard(key) {
      try {
        return ((await client.scard(key)) ?? 0) as number;
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().scard(key);
        }
        throw err;
      }
    },
    async sadd(key, member) {
      try {
        return (await client.sadd(key, member)) as number;
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().sadd(key, member);
        }
        throw err;
      }
    },
    async del(key) {
      try {
        return (await client.del(key)) as number;
      } catch (err) {
        if (env.NODE_ENV === 'development' && shouldFallback(err)) {
          return getFallbackRedis().del(key);
        }
        throw err;
      }
    },
  };
}

/**
 * Singleton Redis client for hot data (sessions, presence, rate limits).
 */
export function getRedis(): RedisLike {
  if (!redisInstance) {
    const client = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    redisInstance = createUpstashAdapter(client);
  }
  return redisInstance;
}


