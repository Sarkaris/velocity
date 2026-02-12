import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { env } from '@/config/env';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let r2Client: S3Client | null = null;

/**
 * S3-compatible client for Cloudflare R2.
 * File bytes must never go through our API – presigned URLs only (Phase 3).
 */
export function getR2Client(): S3Client {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

export function generateStorageKey(fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = fileName.replace(/\s+/g, '-');
  return `uploads/${id}/${safeName}`;
}

export async function getPresignedUploadUrl(options: {
  key: string;
  contentType?: string | null;
  contentLength?: number | null;
  expiresInSeconds?: number;
}): Promise<string> {
  const client = getR2Client();

  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: options.key,
    ContentType: options.contentType ?? undefined,
    // ContentLength is optional for R2 but helps some clients validate uploads
    ContentLength: options.contentLength ?? undefined,
  });

  const url = await getSignedUrl(client, command, {
    expiresIn: options.expiresInSeconds ?? 15 * 60, // 15 minutes
  });

  return url;
}

export async function getPresignedDownloadUrl(options: {
  key: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const client = getR2Client();

  const command = new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: options.key,
  });

  const url = await getSignedUrl(client, command, {
    expiresIn: options.expiresInSeconds ?? 15 * 60, // 15 minutes
  });

  return url;
}


