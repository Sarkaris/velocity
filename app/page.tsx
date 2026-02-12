'use client';

import { useEffect, useMemo, useState } from 'react';

type StartResponse = {
  transferCode: string;
  expiresAt: number;
};

type JoinResponse = {
  transferCode: string;
  receiverId: string;
  receiverCount: number;
};

type UploadUrlResponse = {
  uploadUrl: string;
  storageKey: string;
  expiresAt: number;
};

type CompleteResponse = {
  transferCode: string;
  status: 'started' | 'completed' | 'failed';
  receiverCount: number;
};

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

function getWsUrl(path: string) {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}${path}`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [transferCode, setTransferCode] = useState<string | null>(null);
  const [senderReceiverCount, setSenderReceiverCount] = useState(0);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinState, setJoinState] = useState<JoinResponse | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [liveReceiverCount, setLiveReceiverCount] = useState<number | null>(
    null,
  );
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [streamWs, setStreamWs] = useState<WebSocket | null>(null);

  const [isReceivingLive, setIsReceivingLive] = useState(false);
  const [liveReceivePercent, setLiveReceivePercent] = useState<number | null>(
    null,
  );
  const [liveFile, setLiveFile] = useState<{
    url: string;
    fileName: string;
  } | null>(null);
  const [liveTransferCode, setLiveTransferCode] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (ws) {
        ws.close();
      }
      if (streamWs) {
        streamWs.close();
      }
    };
  }, [ws, streamWs]);

  const canSend = useMemo(() => !!file && !isSending, [file, isSending]);

  function uploadFileWithProgress(url: string, fileToUpload: File) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const pct = Math.round((event.loaded / event.total) * 100);
        setUploadPercent(pct);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadPercent(100);
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        reject(new Error('Upload failed'));
      };

      xhr.send(fileToUpload);
    });
  }

  async function handleSend() {
    if (!file) {
      setSendError('Select a file to send.');
      return;
    }

    setIsSending(true);
    setSendError(null);
    setUploadPercent(null);

    try {
      // 1) Start transfer session
      const startRes = await fetch('/api/transfers/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileSize: file.size,
          mimeType: file.type || null,
        }),
      });

      if (!startRes.ok) {
        const body = await startRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to start transfer');
      }

      const startData = (await startRes.json()) as StartResponse;
      setTransferCode(startData.transferCode);
      // Cloud path does not use live transfer code.
      setLiveTransferCode(null);
      openLiveSocket(startData.transferCode);

      // 2) Get presigned upload URL
      const uploadUrlRes = await fetch('/api/transfers/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferCode: startData.transferCode,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || null,
        }),
      });

      if (!uploadUrlRes.ok) {
        const body = await uploadUrlRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create upload URL');
      }

      const uploadUrlData = (await uploadUrlRes.json()) as UploadUrlResponse;

      // 3) Upload file directly to storage
      await uploadFileWithProgress(uploadUrlData.uploadUrl, file);

      // 4) Mark transfer as completed
      const completeRes = await fetch('/api/transfers/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferCode: startData.transferCode,
          success: true,
        }),
      });

      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to complete transfer');
      }

      const completed = (await completeRes.json()) as CompleteResponse;
      setSenderReceiverCount(completed.receiverCount);
    } catch (err: any) {
      setSendError(err?.message || 'Unexpected error while sending file');
    } finally {
      setIsSending(false);
    }
  }

  async function handleSendLive() {
    if (!file) {
      setSendError('Select a file to send.');
      return;
    }

    setSendError(null);
    setUploadPercent(null);

    try {
      let code = liveTransferCode;

      // Phase 1: no live session yet → create transfer & show key only.
      if (!code) {
        const startRes = await fetch('/api/transfers/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileSize: file.size,
            mimeType: file.type || null,
          }),
        });

        if (!startRes.ok) {
          const body = await startRes.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to start transfer');
        }

        const startData = (await startRes.json()) as StartResponse;
        code = startData.transferCode;
        setTransferCode(startData.transferCode);
        setLiveTransferCode(startData.transferCode);
        openLiveSocket(startData.transferCode);
        // Clear any previous live file from another session.
        if (liveFile) {
          URL.revokeObjectURL(liveFile.url);
          setLiveFile(null);
        }

        // At this point we only generated the key. The sender should share it
        // with the receiver, the receiver joins, and then the sender clicks
        // "Start live stream" (this button again) to actually stream.
        return;
      }

      // Phase 2: we already have a live transfer code → actually stream.
      setIsSending(true);
      // 2) Open WebSocket stream as sender
      const url = getWsUrl(
        `/api/transfers/stream?code=${encodeURIComponent(
          code,
        )}&role=sender`,
      );
      if (!url) {
        throw new Error('Streaming is not supported in this environment.');
      }

      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      let closed = false;

      socket.onclose = () => {
        closed = true;
      };

      socket.onerror = () => {
        // Surface a generic error; specific issues are rare and mostly network related.
        setSendError('Live streaming connection error.');
      };

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          try {
            const meta: StreamControlMessage = {
              type: 'meta',
              fileName: file.name,
              fileSize: file.size,
              mimeType: file.type || null,
            };
            socket.send(JSON.stringify(meta));
          } catch (err) {
            reject(err);
            return;
          }

          // Stream the file as chunks.
          const reader = file.stream().getReader();
          let sentBytes = 0;

          const pump = async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;

                if (closed || socket.readyState !== WebSocket.OPEN) {
                  throw new Error('Live stream connection closed.');
                }

                const view = value as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
                const chunk = view.buffer.slice(
                  view.byteOffset,
                  view.byteOffset + view.byteLength,
                );
                socket.send(chunk);
                sentBytes += chunk.byteLength;
                const pct = Math.round((sentBytes / file.size) * 100);
                setUploadPercent(pct);
              }

              // Notify receivers that the stream has ended.
              const endMsg: StreamControlMessage = { type: 'end' };
              socket.send(JSON.stringify(endMsg));

              resolve();
            } catch (err) {
              reject(err);
            }
          };

          pump().catch(reject);
        };
      });

      // 3) Mark transfer as completed via existing API so DB/Redis stay in sync.
      const completeRes = await fetch('/api/transfers/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferCode: code,
          success: true,
        }),
      });

      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to complete transfer');
      }

      const completed = (await completeRes.json()) as CompleteResponse;
      setSenderReceiverCount(completed.receiverCount);
    } catch (err: any) {
      setSendError(err?.message || 'Unexpected error while live streaming file');
    } finally {
      setIsSending(false);
    }
  }

  function openLiveSocket(code: string) {
    if (!code) return;

    const url = getWsUrl(`/api/transfers/live?code=${encodeURIComponent(code)}`);
    if (!url) return;

    if (ws) {
      ws.close();
    }

    const socket = new WebSocket(url);

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as LiveMessage;
        if (data.type === 'receiver_count') {
          setLiveReceiverCount(data.receiverCount);
        } else if (data.type === 'error') {
          setJoinError(data.message);
          socket.close();
        }
      } catch {
        // ignore malformed messages
      }
    };

    // Intentionally ignore low-level socket errors in UI; the join response
    // already contains an initial receiver count, and live updates are
    // best-effort only.
    socket.onerror = () => {};

    setWs(socket);
  }

  function openStreamSocket(code: string, receiverId: string) {
    if (!code || !receiverId) return;

    const url = getWsUrl(
      `/api/transfers/stream?code=${encodeURIComponent(
        code,
      )}&role=receiver&receiverId=${encodeURIComponent(receiverId)}`,
    );
    if (!url) return;

    if (streamWs) {
      streamWs.close();
    }

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    let expectedSize = 0;
    let fileName = 'download.bin';
    let mimeType: string | null = null;
    const chunks: BlobPart[] = [];
    let receivedBytes = 0;

    socket.onmessage = (event) => {
      const { data } = event;

      if (typeof data === 'string') {
        let parsed: StreamControlMessage | null = null;
        try {
          parsed = JSON.parse(data) as StreamControlMessage;
        } catch {
          // ignore malformed control messages
        }

        if (!parsed) return;

        if (parsed.type === 'meta') {
          fileName = parsed.fileName || 'download.bin';
          mimeType = parsed.mimeType;
          expectedSize = parsed.fileSize;
          setIsReceivingLive(true);
          setLiveReceivePercent(0);
        } else if (parsed.type === 'end') {
          setIsReceivingLive(false);
          setLiveReceivePercent(100);

          const blob = new Blob(chunks, {
            type: mimeType || 'application/octet-stream',
          });
          const urlObject = URL.createObjectURL(blob);
          setLiveFile({ url: urlObject, fileName });
          const a = document.createElement('a');
          a.href = urlObject;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else if (parsed.type === 'error') {
          setIsReceivingLive(false);
          setDownloadError(parsed.message);
        }

        return;
      }

      // Binary chunk from sender.
      const chunk = data as ArrayBuffer;
      chunks.push(chunk);
      receivedBytes += chunk.byteLength;

      if (expectedSize > 0) {
        const pct = Math.round((receivedBytes / expectedSize) * 100);
        setLiveReceivePercent(pct);
      }
    };

    socket.onerror = () => {
      setIsReceivingLive(false);
      setDownloadError('Live receive connection error.');
    };

    setStreamWs(socket);
  }

  async function handleJoin() {
    const code = joinCodeInput.trim();
    if (!/^\d{6,8}$/.test(code)) {
      setJoinError('Enter a valid 6–8 digit code.');
      return;
    }

    setJoinError(null);

    try {
      const res = await fetch('/api/transfers/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferCode: code }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to join transfer');
      }

      const data = (await res.json()) as JoinResponse;
      setJoinState(data);
      setLiveReceiverCount(data.receiverCount);
      openLiveSocket(code);
      openStreamSocket(code, data.receiverId);
    } catch (err: any) {
      setJoinError(err?.message || 'Unexpected error while joining transfer');
    }
  }

  async function handleDownload() {
    if (!joinState) return;

    setIsDownloading(true);
    setDownloadError(null);

    try {
      // If a live-streamed file has already been assembled in this session,
      // prefer serving that directly instead of going through storage.
      if (liveFile) {
        const a = document.createElement('a');
        a.href = liveFile.url;
        a.download = liveFile.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setIsDownloading(false);
        return;
      }

      const res = await fetch('/api/transfers/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferCode: joinState.transferCode }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };

        // For live-streamed transfers (especially in development), there may be
        // no stored file in object storage, so the backend correctly reports
        // "File not found for this transfer". Surface a clearer message in that
        // case rather than a generic error.
        if (body.code === 'NOT_FOUND') {
          throw new Error(
            'This transfer was delivered via live stream and no stored copy is available.',
          );
        }

        throw new Error(body.error || 'Failed to get download URL');
      }

      const data = (await res.json()) as { downloadUrl: string };

      // Open direct R2 URL so bytes never flow through our API.
      window.location.href = data.downloadUrl;
    } catch (err: any) {
      setDownloadError(err?.message || 'Unexpected error while starting download');
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-4 py-12 md:flex-row md:items-start md:gap-16">
        <section className="flex-1 space-y-6">
          <header className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">
              Velocity Transfer
            </h1>
            <p className="text-sm text-zinc-400">
              Send a file using a one-time numeric key. No accounts. No
              history.
            </p>
          </header>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-medium">Send a file</h2>

            <div className="space-y-4">
              <label className="block text-sm font-medium text-zinc-300">
                Choose file
                <input
                  type="file"
                  disabled={isSending}
                  className="mt-2 block w-full text-sm text-zinc-300 disabled:cursor-not-allowed disabled:opacity-60 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-50 hover:file:bg-zinc-600"
                  onChange={(e) => {
                    const selected = e.target.files?.[0] ?? null;
                    setFile(selected);
                    setSendError(null);
                  }}
                />
              </label>

              {file && (
                <p className="text-xs text-zinc-400">
                  {file.name} ({Math.round(file.size / 1024)} KB)
                </p>
              )}

              {uploadPercent !== null && (
                <p className="text-xs text-zinc-400">
                  Uploading: {uploadPercent}%
                </p>
              )}

              <p className="text-xs text-zinc-500">
                Use <span className="font-semibold">Generate key &amp; send</span> for
                a stored transfer, or <span className="font-semibold">Send live (beta)</span>{' '}
                to stream directly to a receiver that is currently online.
              </p>

              <button
                type="button"
                disabled={!canSend}
                onClick={handleSend}
                className="inline-flex items-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-sm transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {isSending ? 'Sending…' : 'Generate key & send'}
              </button>

              <button
                type="button"
                disabled={!canSend}
                onClick={handleSendLive}
                className="inline-flex items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {isSending
                  ? 'Sending live…'
                  : liveTransferCode
                    ? 'Start live stream'
                    : 'Generate live key'}
              </button>

              {sendError && (
                <p className="text-xs text-red-400">{sendError}</p>
              )}

              {transferCode && (
                <div className="mt-4 rounded-md border border-emerald-600/40 bg-emerald-950/40 p-4 text-sm">
                  <p className="font-medium text-emerald-300">
                    Share this key with the receiver:
                  </p>
                  <p className="mt-1 text-2xl font-semibold tracking-[0.35em] text-emerald-100">
                    {transferCode.split('').join(' ')}
                  </p>
                  <p className="mt-3 text-xs text-emerald-200/80">
                    Live receivers joined:{' '}
                    {liveReceiverCount !== null
                      ? liveReceiverCount
                      : senderReceiverCount}
                  </p>
                  {liveTransferCode && (
                    <p className="mt-1 text-[11px] text-emerald-200/80">
                      Ask the receiver to join with this key, then click{' '}
                      <span className="font-semibold">Start live stream</span>.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="flex-1 space-y-6">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-medium">Receive a file</h2>

            <div className="space-y-3">
              <label className="block text-sm font-medium text-zinc-300">
                Enter transfer key
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={8}
                  value={joinCodeInput}
                  onChange={(e) => {
                    setJoinCodeInput(e.target.value);
                    setJoinError(null);
                  }}
                  className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50 outline-none ring-emerald-500/40 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2"
                  placeholder="e.g. 123456"
                />
              </label>

              <button
                type="button"
                onClick={handleJoin}
                className="inline-flex items-center rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 shadow-sm transition hover:bg-white"
              >
                Join transfer
              </button>

              {joinError && (
                <p className="text-xs text-red-400">{joinError}</p>
              )}

              {joinState && (
                <div className="mt-4 space-y-2 rounded-md border border-zinc-700/80 bg-zinc-900 p-4 text-xs text-zinc-300">
                  <p>
                    Joined transfer <span className="font-mono">{joinState.transferCode}</span>.
                  </p>
                  <p>Receiver ID: {joinState.receiverId}</p>
                </div>
              )}

              {joinState && (
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={isDownloading || (isReceivingLive && !liveFile)}
                  className="mt-3 inline-flex items-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-sm transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {isReceivingLive && !liveFile
                    ? 'Waiting for live stream…'
                    : isDownloading
                      ? 'Preparing download…'
                      : 'Download file'}
                </button>
              )}

              {downloadError && (
                <p className="text-xs text-red-400">{downloadError}</p>
              )}

              {liveReceiverCount !== null && (
                <p className="mt-2 text-xs text-zinc-400">
                  Live receivers on this transfer: {liveReceiverCount}
                </p>
              )}

              {isReceivingLive && (
                <p className="mt-1 text-xs text-zinc-400">
                  Receiving live stream
                  {liveReceivePercent !== null
                    ? `: ${liveReceivePercent}%`
                    : '…'}
                </p>
              )}
            </div>
          </div>

          <p className="text-xs text-zinc-500">
            Files are temporary and tied to a single transfer key. No accounts,
            minimal logs, and sessions expire automatically.
          </p>
        </section>
      </main>
    </div>
  );
}
