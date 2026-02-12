'use client';

import Image from 'next/image';
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
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-950 to-black text-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-10 md:px-8 lg:px-10">
        {/* Hero */}
        <header className="grid gap-10 pb-10 md:grid-cols-[minmax(0,3fr),minmax(0,2fr)] md:items-center">
          <div className="space-y-6">
            <p className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/5 px-3 py-1 text-xs font-medium text-emerald-300">
              Fast, ephemeral file handoff
            </p>
            <div className="space-y-4">
              <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                Share files in seconds,
                <span className="block text-emerald-400">with just a code.</span>
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-zinc-400 sm:text-base">
                Velocity creates a short numeric key that you can send over chat or call.
                Your file uploads directly to storage, and the receiver downloads it
                without accounts, history, or friction.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                No signup, no inbox clutter
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1">
                End‑to‑end: browser → storage
              </span>
            </div>
          </div>
          {/* <div className="relative hidden h-64 overflow-hidden rounded-3xl border border-zinc-800/80 bg-zinc-900/60 shadow-2xl shadow-emerald-500/10 md:block">
            <Image
              src="/hero.png"
              alt="Velocity Transfer UI illustration"
              fill
              priority
              className="object-cover object-center opacity-90"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/40" />
          </div> */}
        </header>

        {/* Main panels */}
        <main className="grid flex-1 gap-8 md:grid-cols-2">
          {/* Send panel */}
          <section className="space-y-5">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/80 p-6 shadow-xl shadow-black/40 backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">
                    Sender
                  </h2>
                  <p className="mt-1 text-base font-medium text-zinc-50">
                    Upload a file &amp; generate a key
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <label className="block text-xs font-medium text-zinc-300">
                  File to send
                  <input
                    type="file"
                    disabled={isSending}
                    className="mt-2 block w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none ring-emerald-500/40 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-emerald-950 hover:file:bg-emerald-500 focus:border-emerald-500 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                    onChange={(e) => {
                      const selected = e.target.files?.[0] ?? null;
                      setFile(selected);
                      setSendError(null);
                    }}
                  />
                </label>

                {file && (
                  <p className="text-xs text-zinc-400">
                    {file.name}{' '}
                    <span className="text-zinc-500">
                      ({Math.round(file.size / 1024)} KB)
                    </span>
                  </p>
                )}

                {uploadPercent !== null && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span>Uploading</span>
                      <span>{uploadPercent}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all"
                        style={{ width: `${uploadPercent}%` }}
                      />
                    </div>
                  </div>
                )}

                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Velocity uploads directly from your browser to secure object storage.
                  Files are temporary and scoped to a single numeric key.
                </p>

                <button
                  type="button"
                  disabled={!canSend}
                  onClick={handleSend}
                  className="inline-flex w-full items-center justify-center rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-medium text-emerald-950 shadow-sm shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {isSending ? 'Sending…' : 'Generate key & send'}
                </button>

                {/* Live streaming controls are kept in code but hidden for now */}
                {/*
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={handleSendLive}
                  className="inline-flex w-full items-center justify-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {isSending
                    ? 'Sending live…'
                    : liveTransferCode
                      ? 'Start live stream'
                      : 'Generate live key'}
                </button>
                */}

                {sendError && (
                  <p className="text-xs text-red-400">{sendError}</p>
                )}

                {transferCode && (
                  <div className="mt-4 space-y-3 rounded-xl border border-emerald-600/40 bg-emerald-950/40 p-4 text-xs">
                    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-300">
                      Share this key
                    </p>
                    <p className="text-2xl font-semibold tracking-[0.35em] text-emerald-100">
                      {transferCode.split('').join(' ')}
                    </p>
                    <p className="text-[11px] text-emerald-200/80">
                      Receivers joined:{' '}
                      {liveReceiverCount !== null
                        ? liveReceiverCount
                        : senderReceiverCount}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Receive panel */}
          <section className="space-y-5">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/80 p-6 shadow-xl shadow-black/40 backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">
                    Receiver
                  </h2>
                  <p className="mt-1 text-base font-medium text-zinc-50">
                    Enter the code &amp; download
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <label className="block text-xs font-medium text-zinc-300">
                  Transfer key
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
                    className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50 outline-none ring-emerald-500/40 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2"
                    placeholder="e.g. 123456"
                  />
                </label>

                <button
                  type="button"
                  onClick={handleJoin}
                  className="inline-flex w-full items-center justify-center rounded-md bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-950 shadow-sm transition hover:bg-white"
                >
                  Join transfer
                </button>

                {joinError && (
                  <p className="text-xs text-red-400">{joinError}</p>
                )}

                {joinState && (
                  <div className="mt-3 space-y-2 rounded-xl border border-zinc-700/80 bg-zinc-900 p-4 text-xs text-zinc-300">
                    <p>
                      Joined transfer{' '}
                      <span className="font-mono">
                        {joinState.transferCode}
                      </span>
                      .
                    </p>
                    <p className="text-zinc-400">Receiver ID: {joinState.receiverId}</p>
                  </div>
                )}

                {joinState && (
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={isDownloading || (isReceivingLive && !liveFile)}
                    className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-medium text-emerald-950 shadow-sm shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
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
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Live receivers on this transfer: {liveReceiverCount}
                  </p>
                )}

                {isReceivingLive && (
                  <p className="mt-1 text-[11px] text-zinc-400">
                    Receiving live stream
                    {liveReceivePercent !== null
                      ? `: ${liveReceivePercent}%`
                      : '…'}
                  </p>
                )}
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              Files are temporary and tied to a single transfer key. No accounts, minimal
              logs, and sessions expire automatically based on server configuration.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
