import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import { env } from '@/config/env';

let sqlInstance: NeonQueryFunction<any, any> | null = null;

/**
 * Singleton Neon SQL client for cold data (transfers, files, analytics).
 */
export function getDb(): NeonQueryFunction<any, any> {
  if (!sqlInstance) {
    sqlInstance = neon(env.DATABASE_URL);
  }
  return sqlInstance;
}


