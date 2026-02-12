export const transferConfig = {
  keyLength: {
    min: 6,
    max: 8,
  },
  // Longer TTL to comfortably support large uploads (e.g. 2GB) on slower
  // connections while still enforcing automatic expiry.
  sessionTtlSeconds: 60 * 60, // 60 minutes
  maxReceiversPerSession: 10,

  rateLimit: {
    maxAttemptsPerMinutePerIp: 20,
  },
} as const;

export const redisKeys = {
  transfer: (code: string) => `transfer:${code}`,
  receivers: (code: string) => `receivers:${code}`,
  attempts: (ip: string) => `attempts:${ip}`,
} as const;


