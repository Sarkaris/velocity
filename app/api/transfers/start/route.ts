import { NextRequest, NextResponse } from 'next/server';
import { createTransferSession } from '@/services/session';
import { createTransferRecord } from '@/services/transfer';
import type { StartTransferInput } from '@/types/transfer';

export const runtime = 'nodejs';

function parseBody(body: any): StartTransferInput {
  const fileSize = typeof body?.fileSize === 'number' ? body.fileSize : null;
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : null;

  return { fileSize, mimeType };
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const input = parseBody(json);

    const sessionResult = await createTransferSession(input);

    await createTransferRecord({
      transferCode: sessionResult.transferCode,
      fileSize: input.fileSize,
    });

    return NextResponse.json(
      {
        transferCode: sessionResult.transferCode,
        expiresAt: sessionResult.expiresAt,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (err?.status && err?.code) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }

    console.error('Start transfer error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


