import { getDb } from '@/lib/postgres/client';

export function getAnalyticsDb() {
  return getDb();
}


