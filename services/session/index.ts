import crypto from 'crypto';
import type { Redis } from '@upstash/redis';
import { getRedis } from '@/lib/redis/client';
import { transferConfig, redisKeys } from '@/config/appConfig';
import type {
  TransferSessionRedis,
  StartTransferInput,
  StartTransferResult,
  JoinTransferResult,
} from '@/types/transfer';
import { AppError } from '@/services/shared/errors';

function redis(): Redis {
  return getRedis();
}

// Key generation

function generateNumericCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += (bytes[i] % 10).toString(10);
  }
  return out;
}

async function generateUniqueTransferCode(): Promise<string> {
  const len = transferConfig.keyLength.min;
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    const code = generateNumericCode(len);
    const key = redisKeys.transfer(code);
    const existing = await redis().get(key);
    if (!existing) return code;
  }

  throw new Error('Failed to generate unique transfer code');
}

// Rate limiting

async function enforceRateLimit(ip: string): Promise<void> {
  if (!ip) return;

  const key = redisKeys.attempts(ip);
  const r = redis();

  const current = await r.incr(key);
  if (current === 1) {
    await r.expire(key, 60);
  }

  if (current > transferConfig.rateLimit.maxAttemptsPerMinutePerIp) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many attempts. Please slow down.',
      429
    );
  }
}

// Session lifecycle

export async function createTransferSession(
  input: StartTransferInput
): Promise<StartTransferResult> {
  const { fileSize, mimeType } = input;

  if (fileSize != null && fileSize < 0) {
    throw new AppError('INVALID_INPUT', 'Invalid file size', 400);
  }

  const now = Date.now();
  const ttlMillis = transferConfig.sessionTtlSeconds * 1000;
  const expiresAt = now + ttlMillis;

  const sessionId = crypto.randomUUID();
  const transferCode = await generateUniqueTransferCode();

  const session: TransferSessionRedis = {
    sessionId,
    transferCode,
    status: 'started',
    createdAt: now,
    expiresAt,
    fileSize: fileSize ?? null,
    mimeType: mimeType ?? null,
    storageKey: null,
  };

  const key = redisKeys.transfer(transferCode);

  await redis().set(key, session, {
    ex: transferConfig.sessionTtlSeconds,
  });

  return { transferCode, expiresAt };
}

export async function joinTransferSession(params: {
  transferCode: string;
  ipAddress: string;
}): Promise<JoinTransferResult> {
  const { transferCode, ipAddress } = params;

  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    throw new AppError('INVALID_INPUT', 'Invalid transfer code', 400);
  }

  await enforceRateLimit(ipAddress);

  const r = redis();
  const transferKey = redisKeys.transfer(transferCode);
  const receiversKey = redisKeys.receivers(transferCode);

  const session = (await r.get(transferKey)) as TransferSessionRedis | null;
  if (!session) {
    throw new AppError('NOT_FOUND', 'Transfer not found or expired', 404);
  }

  const currentCount = (await r.scard(receiversKey)) ?? 0;
  if (currentCount >= transferConfig.maxReceiversPerSession) {
    throw new AppError('MAX_RECEIVERS', 'Maximum receivers reached', 403);
  }

  const receiverId = crypto.randomUUID();
  await r.sadd(receiversKey, receiverId);
  await r.expire(receiversKey, transferConfig.sessionTtlSeconds);

  const receiverCount = (await r.scard(receiversKey)) ?? 1;

  return {
    transferCode,
    receiverId,
    receiverCount,
  };
}


