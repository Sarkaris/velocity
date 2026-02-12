import { getRedis } from '@/lib/redis/client';
import { redisKeys } from '@/config/appConfig';

export async function getReceiverCount(transferCode: string): Promise<number> {
  const r = getRedis();
  const receiversKey = redisKeys.receivers(transferCode);
  const count = await r.scard(receiversKey);
  return count ?? 0;
}

