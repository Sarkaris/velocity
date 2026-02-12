type NodeEnv = 'development' | 'test' | 'production';

type Env = {
  NODE_ENV: NodeEnv;

  DATABASE_URL: string; // Neon Postgres

  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;

  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;

  APP_URL: string; // public base URL of this app
};

const requiredKeys: (keyof Env)[] = [
  'NODE_ENV',
  'DATABASE_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'APP_URL',
];

function readEnv(): Env {
  const env = process.env;

  const result: Partial<Env> = {
    NODE_ENV: (env.NODE_ENV as NodeEnv) ?? 'development',
    DATABASE_URL: env.DATABASE_URL,
    UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
    R2_ENDPOINT: env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET,
    APP_URL: env.APP_URL,
  };

  const missing = requiredKeys.filter((key) => !result[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  return result as Env;
}

export const env: Env = readEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';


