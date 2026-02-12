import { NextRequest, NextResponse } from 'next/server';
import { createDownloadUrlForTransfer } from '@/services/transfer';

export const runtime = 'nodejs';

function parseBody(body: any) {
  const transferCode = String(body?.transferCode ?? '');
  return { transferCode };
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { transferCode } = parseBody(json);

    const result = await createDownloadUrlForTransfer(transferCode);

    return NextResponse.json(
      {
        downloadUrl: result.downloadUrl,
        expiresAt: result.expiresAt,
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

    console.error('Create download URL error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

