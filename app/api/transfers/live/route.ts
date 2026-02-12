import { NextRequest, NextResponse } from 'next/server';
import { redisKeys, transferConfig } from '@/config/appConfig';
import { getRedis } from '@/lib/redis/client';
import type { TransferSessionRedis } from '@/types/transfer';
import { getReceiverCount } from '@/services/live/receiverCount';

export const runtime = 'edge';

type LiveMessage =
  | {
      type: 'receiver_count';
      transferCode: string;
      receiverCount: number;
    }
  | {
      type: 'error';
      message: string;
    };

export async function GET(req: NextRequest) {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new NextResponse('Expected WebSocket', { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const transferCode = searchParams.get('code') ?? '';

  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    return new NextResponse('Invalid transfer code', { status: 400 });
  }

  // WebSocketPair is available in the Edge runtime, but not in TypeScript's DOM lib
  const { 0: client, 1: server } = (new (globalThis as any).WebSocketPair()) as {
    0: WebSocket;
    1: WebSocket;
  };

  const redis = getRedis();
  const transferKey = redisKeys.transfer(transferCode);

  let interval: ReturnType<typeof setInterval> | undefined;

  async function send(msg: LiveMessage) {
    try {
      server.send(JSON.stringify(msg));
    } catch {
      // ignore send errors
    }
  }

  async function startStreaming() {
    const session = (await redis.get(
      transferKey
    )) as TransferSessionRedis | null;
    if (!session) {
      await send({
        type: 'error',
        message: 'Transfer not found or expired',
      });
      server.close(1000, 'Transfer not found');
      return;
    }

    // Immediately send current receiver count
    const initialCount = await getReceiverCount(transferCode);
    await send({
      type: 'receiver_count',
      transferCode,
      receiverCount: initialCount,
    });

    const intervalMs = Math.min(
      5_000,
      transferConfig.sessionTtlSeconds * 1000
    );

    interval = setInterval(async () => {
      try {
        const currentSession = (await redis.get(
          transferKey
        )) as TransferSessionRedis | null;
        if (!currentSession) {
          await send({
            type: 'error',
            message: 'Transfer expired',
          });
          server.close(1000, 'Transfer expired');
          if (interval) clearInterval(interval);
          return;
        }

        const count = await getReceiverCount(transferCode);
        await send({
          type: 'receiver_count',
          transferCode,
          receiverCount: count,
        });
      } catch {
        // swallow errors; next tick may succeed
      }
    }, intervalMs);
  }

  // Accept the server side of the WebSocket and start streaming (Edge runtime)
  server.accept?.();
  startStreaming().catch(() => {
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  server.addEventListener('close', () => {
    if (interval) {
      clearInterval(interval);
    }
  });

  server.addEventListener('error', () => {
    if (interval) {
      clearInterval(interval);
    }
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  return new Response(null, {
    status: 101,
    // @ts-expect-error - webSocket is a valid ResponseInit option in Edge runtime
    webSocket: client,
  });
}

