import { NextRequest, NextResponse } from 'next/server';
import { redisKeys, transferConfig } from '@/config/appConfig';
import { getRedis } from '@/lib/redis/client';
import type { TransferSessionRedis } from '@/types/transfer';

export const runtime = 'edge';

type StreamControlMessage =
  | {
      type: 'meta';
      fileName: string;
      fileSize: number;
      mimeType: string | null;
    }
  | {
      type: 'end';
    }
  | {
      type: 'error';
      message: string;
    };

type StreamGroup = {
  sender?: WebSocket;
  receivers: Set<WebSocket>;
};

// In-memory map per Edge instance that groups sender/receivers by transfer code.
const streamGroups = new Map<string, StreamGroup>();

function getOrCreateGroup(transferCode: string): StreamGroup {
  let group = streamGroups.get(transferCode);
  if (!group) {
    group = { sender: undefined, receivers: new Set() };
    streamGroups.set(transferCode, group);
  }
  return group;
}

function removeConnection(transferCode: string, role: 'sender' | 'receiver', ws: WebSocket) {
  const group = streamGroups.get(transferCode);
  if (!group) return;

  if (role === 'sender') {
    if (group.sender === ws) {
      group.sender = undefined;
    }
  } else {
    group.receivers.delete(ws);
  }

  if (!group.sender && group.receivers.size === 0) {
    streamGroups.delete(transferCode);
  }
}

async function validateSession(
  transferCode: string
): Promise<TransferSessionRedis | null> {
  const redis = getRedis();
  const transferKey = redisKeys.transfer(transferCode);
  const session = (await redis.get(transferKey)) as TransferSessionRedis | null;
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt <= now) {
    return null;
  }

  if (session.status !== 'started') {
    return null;
  }

  return session;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const transferCode = searchParams.get('code') ?? '';
  const roleParam = searchParams.get('role') ?? '';

  if (!transferCode || !/^\d{6,8}$/.test(transferCode)) {
    return new NextResponse('Invalid transfer code', { status: 400 });
  }

  const role = roleParam === 'sender' || roleParam === 'receiver' ? roleParam : null;
  if (!role) {
    return new NextResponse('Invalid role', { status: 400 });
  }

  // WebSocketPair is available in the Edge runtime, but not in TypeScript's DOM lib
  const { 0: client, 1: server } = (new (globalThis as any).WebSocketPair()) as {
    0: WebSocket;
    1: WebSocket;
  };

  // Edge runtime WebSocket has accept(); optional chaining keeps TS happy
  server.accept?.();

  async function start() {
    const session = await validateSession(transferCode);
    if (!session) {
      try {
        const msg: StreamControlMessage = {
          type: 'error',
          message: 'Transfer not found, expired, or not accepting streams',
        };
        server.send(JSON.stringify(msg));
      } catch {
        // ignore
      }
      try {
        server.close(1000, 'Invalid transfer session');
      } catch {
        // ignore
      }
      return;
    }

    const group = getOrCreateGroup(transferCode);

    if (role === 'sender') {
      // If a previous sender exists, close it to avoid conflicting streams.
      if (group.sender && group.sender !== server) {
        try {
          group.sender.close(4000, 'Another sender connected');
        } catch {
          // ignore
        }
      }
      group.sender = server;
    } else {
      group.receivers.add(server);
    }

    function broadcastToReceivers(data: string | ArrayBuffer | Uint8Array) {
      for (const receiver of group.receivers) {
        try {
          receiver.send(data as any);
        } catch {
          // ignore send errors to individual receivers
        }
      }
    }

    if (role === 'sender') {
      server.addEventListener('message', (event: MessageEvent) => {
        const data = event.data;

        // Sender sends control JSON ("meta", "end", "error") as strings,
        // and raw binary chunks as ArrayBuffer/Uint8Array. We relay to receivers.
        if (typeof data === 'string') {
          let parsed: StreamControlMessage | null = null;
          try {
            parsed = JSON.parse(data) as StreamControlMessage;
          } catch {
            // ignore malformed JSON from sender
          }

          if (parsed) {
            if (parsed.type === 'end') {
              // Forward end to receivers and keep connections open briefly;
              // clients can decide when to close.
              broadcastToReceivers(JSON.stringify(parsed));
            } else if (parsed.type === 'meta' || parsed.type === 'error') {
              broadcastToReceivers(JSON.stringify(parsed));
            }
          }
        } else {
          // Binary chunk from sender: relay directly.
          try {
            if (data instanceof ArrayBuffer) {
              broadcastToReceivers(data);
            } else if (data instanceof Uint8Array) {
              broadcastToReceivers(data);
            }
          } catch {
            // swallow
          }
        }
      });
    } else {
      // Receivers generally don't send data; ignore any messages they send.
      server.addEventListener('message', () => {
        // no-op
      });
    }
  }

  start().catch(() => {
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  server.addEventListener('close', () => {
    removeConnection(transferCode, role, server);
  });

  server.addEventListener('error', () => {
    removeConnection(transferCode, role, server);
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

