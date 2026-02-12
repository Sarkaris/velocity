import { NextRequest, NextResponse } from 'next/server';
import { joinTransferSession } from '@/services/session';

export const runtime = 'nodejs';

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    return xff.split(',')[0].trim();
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;
  // @ts-expect-error - not part of NextRequest type, but may exist at runtime
  return (req as any).ip ?? '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const transferCode = String(body?.transferCode ?? '');

    const ip = getClientIp(req);

    const result = await joinTransferSession({
      transferCode,
      ipAddress: ip,
    });

    return NextResponse.json(
      {
        transferCode: result.transferCode,
        receiverId: result.receiverId,
        receiverCount: result.receiverCount,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err?.status && err?.code) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }

    console.error('Join transfer error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


