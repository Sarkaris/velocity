import { NextRequest, NextResponse } from 'next/server';
import { getRedis } from '@/lib/redis/client';
import { redisKeys } from '@/config/appConfig';
import type { TransferSessionRedis } from '@/types/transfer';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const transferCode = searchParams.get('code') ?? '';

    if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
      return NextResponse.json(
        { error: 'Invalid transfer code', code: 'INVALID_INPUT' },
        { status: 400 }
      );
    }

    const transferKey = redisKeys.transfer(transferCode);
    const session = (await getRedis().get(transferKey)) as TransferSessionRedis | null;

    if (!session) {
      return NextResponse.json(
        { error: 'Transfer not found or expired', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        transferCode,
        status: session.status,
        isReadyForDownload: session.status === 'completed' && !!session.storageKey,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error('Transfer status error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

