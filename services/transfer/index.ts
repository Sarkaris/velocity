import type { NeonQueryFunction } from '@neondatabase/serverless';
import { getDb } from '@/lib/postgres/client';
import { getRedis } from '@/lib/redis/client';
import {
  generateStorageKey,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
} from '@/lib/storage/r2';
import { redisKeys, transferConfig } from '@/config/appConfig';
import type {
  TransferStatus,
  TransferSessionRedis,
  CreateUploadUrlInput,
  CreateUploadUrlResult,
  CompleteTransferInput,
  CompleteTransferResult,
  CreateDownloadUrlResult,
} from '@/types/transfer';
import { AppError } from '@/services/shared/errors';
import { getReceiverCount } from '@/services/live/receiverCount';

export interface TransferRecord {
  id: string;
  transfer_code: string;
  file_size: number | null;
  status: TransferStatus;
  receiver_count: number;
  created_at: string;
  completed_at: string | null;
  duration: string | null;
}

function db(): NeonQueryFunction<any, any> {
  return getDb();
}

function redis() {
  return getRedis();
}

export async function createTransferRecord(params: {
  transferCode: string;
  fileSize: number | null;
}): Promise<TransferRecord> {
  const { transferCode, fileSize } = params;

  const sql = db();
  const rows = (await sql`
    INSERT INTO transfers (transfer_code, file_size, status)
    VALUES (${transferCode}, ${fileSize}, 'started')
    RETURNING *
  `) as any[];

  const row = rows[0] as TransferRecord;
  return row;
}

export async function createUploadUrlForTransfer(
  input: CreateUploadUrlInput
): Promise<CreateUploadUrlResult> {
  const { transferCode, fileName, fileSize, mimeType } = input;

  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    throw new AppError('INVALID_INPUT', 'Invalid transfer code', 400);
  }

  if (!fileName || typeof fileName !== 'string') {
    throw new AppError('INVALID_INPUT', 'File name is required', 400);
  }

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new AppError('INVALID_INPUT', 'File size must be positive', 400);
  }

  const r = redis();
  const transferKey = redisKeys.transfer(transferCode);

  const session = (await r.get(transferKey)) as TransferSessionRedis | null;
  if (!session) {
    throw new AppError('NOT_FOUND', 'Transfer not found or expired', 404);
  }

  if (session.status !== 'started') {
    throw new AppError(
      'FORBIDDEN',
      'Transfer is not in a state that accepts uploads',
      403
    );
  }

  const now = Date.now();
  if (session.expiresAt <= now) {
    throw new AppError('NOT_FOUND', 'Transfer has expired', 404);
  }

  const storageKey =
    session.storageKey && session.storageKey.length > 0
      ? session.storageKey
      : generateStorageKey(fileName);

  const uploadUrl = await getPresignedUploadUrl({
    key: storageKey,
    contentType: mimeType,
    contentLength: fileSize,
    // Keep presigned URL lifetime shorter or equal to session TTL
    expiresInSeconds: Math.min(
      transferConfig.sessionTtlSeconds,
      15 * 60 // safety cap
    ),
  });

  // Persist storageKey back into the session for later completion logging
  const updated: TransferSessionRedis = {
    ...session,
    storageKey,
  };

  await r.set(transferKey, updated, {
    ex: transferConfig.sessionTtlSeconds,
  });

  const expiresAt = now + transferConfig.sessionTtlSeconds * 1000;

  return {
    uploadUrl,
    storageKey,
    expiresAt,
  };
}

export async function completeTransfer(
  input: CompleteTransferInput
): Promise<CompleteTransferResult> {
  const { transferCode, success } = input;

  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    throw new AppError('INVALID_INPUT', 'Invalid transfer code', 400);
  }

  const r = redis();
  const transferKey = redisKeys.transfer(transferCode);
  const receiversKey = redisKeys.receivers(transferCode);

  const session = (await r.get(transferKey)) as TransferSessionRedis | null;
  if (!session) {
    throw new AppError('NOT_FOUND', 'Transfer not found or expired', 404);
  }

  const receiverCount = await getReceiverCount(transferCode);

  const sql = db();
  const newStatus: TransferStatus = success ? 'completed' : 'failed';

  const rows = (await sql`
    UPDATE transfers
    SET
      status = ${newStatus},
      receiver_count = ${receiverCount},
      completed_at = NOW(),
      duration = NOW() - created_at
    WHERE transfer_code = ${transferCode}
    RETURNING *
  `) as any[];

  // Persist file metadata if we have a storage key
  if (session.storageKey) {
    const size = session.fileSize;
    const mimeType = session.mimeType;

    await sql`
      INSERT INTO files (transfer_id, storage_key, size, mime_type)
      SELECT id, ${session.storageKey}, ${size}, ${mimeType}
      FROM transfers
      WHERE transfer_code = ${transferCode}
      ON CONFLICT DO NOTHING
    `;
  }

  // Clean up receiver presence; keep minimal session metadata until TTL, so
  // late joins and live views don't see NOT_FOUND immediately.
  await r.del(receiversKey);

  // Update session status and extend TTL a bit for observability
  const updatedSession: TransferSessionRedis = {
    ...session,
    status: newStatus,
  };

  await r.set(transferKey, updatedSession, {
    ex: transferConfig.sessionTtlSeconds,
  });

  const row = rows[0] as TransferRecord;

  return {
    transferCode: rows[0].transfer_code,
    status: rows[0].status,
    receiverCount: rows[0].receiver_count,
  };
}

export async function createDownloadUrlForTransfer(
  transferCode: string
): Promise<CreateDownloadUrlResult> {
  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    throw new AppError('INVALID_INPUT', 'Invalid transfer code', 400);
  }

  const r = redis();
  const transferKey = redisKeys.transfer(transferCode);

  const session = (await r.get(transferKey)) as TransferSessionRedis | null;
  if (!session) {
    throw new AppError('NOT_FOUND', 'Transfer not found or expired', 404);
  }

  if (session.status !== 'completed') {
    throw new AppError(
      'FORBIDDEN',
      'Transfer is not ready for download',
      409
    );
  }

  if (!session.storageKey) {
    throw new AppError('NOT_FOUND', 'File not found for this transfer', 404);
  }

  const now = Date.now();
  const expiresAt = now + Math.min(15 * 60, transferConfig.sessionTtlSeconds) * 1000;

  const downloadUrl = await getPresignedDownloadUrl({
    key: session.storageKey,
    expiresInSeconds: Math.min(15 * 60, transferConfig.sessionTtlSeconds),
  });

  return {
    downloadUrl,
    expiresAt,
  };
}


