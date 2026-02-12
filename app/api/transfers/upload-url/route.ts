import { NextRequest, NextResponse } from 'next/server';
import { createUploadUrlForTransfer } from '@/services/transfer';

export const runtime = 'nodejs';

function parseBody(body: any) {
  const transferCode = String(body?.transferCode ?? '');
  const fileName = String(body?.fileName ?? '');
  const fileSize = Number(body?.fileSize);
  const mimeType =
    typeof body?.mimeType === 'string' ? (body.mimeType as string) : null;

  return {
    transferCode,
    fileName,
    fileSize,
    mimeType,
  };
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const input = parseBody(json);

    const result = await createUploadUrlForTransfer(input);

    return NextResponse.json(
      {
        uploadUrl: result.uploadUrl,
        storageKey: result.storageKey,
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

    console.error('Create upload URL error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

