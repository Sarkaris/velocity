export type TransferStatus = 'started' | 'completed' | 'failed';

export interface TransferSessionRedis {
  sessionId: string; // internal UUID, never exposed
  transferCode: string; // 6–8 digits
  status: TransferStatus;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  fileSize: number | null;
  mimeType: string | null;
  storageKey: string | null;
}

export interface StartTransferInput {
  fileSize: number | null;
  mimeType: string | null;
}

export interface StartTransferResult {
  transferCode: string;
  expiresAt: number;
}

export interface JoinTransferResult {
  transferCode: string;
  receiverId: string;
  receiverCount: number;
}

export interface CreateUploadUrlInput {
  transferCode: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
}

export interface CreateUploadUrlResult {
  uploadUrl: string;
  storageKey: string;
  expiresAt: number;
}

export interface CompleteTransferInput {
  transferCode: string;
  success: boolean;
}

export interface CompleteTransferResult {
  transferCode: string;
  status: TransferStatus;
  receiverCount: number;
}

export interface CreateDownloadUrlResult {
  downloadUrl: string;
  expiresAt: number;
}


