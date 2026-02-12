import { NextRequest, NextResponse } from 'next/server';
import { completeTransfer } from '@/services/transfer';

export const runtime = 'nodejs';

function parseBody(body: any) {
  const transferCode = String(body?.transferCode ?? '');
  const success =
    typeof body?.success === 'boolean'
      ? (body.success as boolean)
      : body?.success === 'true';

  return {
    transferCode,
    success,
  };
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const input = parseBody(json);

    const result = await completeTransfer(input);

    return NextResponse.json(
      {
        transferCode: result.transferCode,
        status: result.status,
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

    console.error('Complete transfer error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

