import { claimPath, closeRoom, fetchRoom, publishGuestKey, type ShareMode } from "@/lib/share/api";
import { deriveSessionKey, type PublicJwk } from "@/lib/share/crypto";
import { CHUNK_BYTES, formatBytes, MAX_BYTES, MEMORY_THRESHOLD_BYTES, RELAY_CAP_BYTES } from "@/lib/share/format";
import { sanitizeFileName } from "@/lib/share/file-sanitize";
import { FileLink } from "@/lib/share/file-link";
import { createRelayTunnel } from "@/lib/share/relay";
import { SecurePipe, type Tunnel } from "@/lib/share/secure-pipe";
import { Sha256 } from "@/lib/share/sha256";

export type SessionEvent =
  | { type: "log"; line: string }
  | { type: "path"; label: string }
  | { type: "verified" }
  | {
      type: "progress";
      name: string;
      index: number;
      sent: number;
      size: number;
      sentTotal: number;
      grand: number;
    }
  | { type: "file"; name: string; size: number; mime: string; url: string; diskStreamed?: boolean }
  | { type: "batch-complete" }
  | { type: "complete" }
  | { type: "error"; message: string }
  | { type: "ready-for-files"; sendBatch: (files: File[]) => Promise<void> }
  | {
      type: "stream-request";
      file: { i: number; name: string; size: number; mime: string };
      respond: (writable: FileSystemWritableFileStream | null) => void;
    }
  | {
      type: "file-warning";
      /** Sanitized (safe) name to display and use for the save dialog. */
      safeName: string;
      /** Raw name as sent by the peer, for informational display only. */
      rawName: string;
      warning: string;
      /** Call with true to accept (download the file), false to reject. */
      respond: (accept: boolean) => void;
    };

interface CommonOpts {
  code: string;
  mode: ShareMode;
  privateKey: CryptoKey;
  signal: AbortSignal;
  onEvent: (event: SessionEvent) => void;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function aborted(signal: AbortSignal) {
  return signal.aborted;
}

async function waitForGuestKey(code: string, signal: AbortSignal): Promise<PublicJwk> {
  for (;;) {
    if (aborted(signal)) throw new DOMException("Aborted", "AbortError");
    const room = await fetchRoom(code);
    if (!room) throw new Error("This passcode expired.");
    if (room.guestKey) return room.guestKey;
    await sleep(400, signal);
  }
}

async function openTunnel(opts: {
  code: string;
  role: "host" | "guest";
  lanOnly: boolean;
  signal: AbortSignal;
  onLog: (line: string) => void;
}): Promise<Tunnel> {
  if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const link = new FileLink(opts.code, opts.role, opts.lanOnly);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let extra: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (extra) clearTimeout(extra);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      link.close();
      reject(error);
    };
    const succeed = (tunnel: Tunnel) => {
      if (settled) {
        tunnel.close();
        return;
      }
      settled = true;
      cleanup();
      resolve(tunnel);
    };

    opts.signal.addEventListener(
      "abort",
      () => fail(new DOMException("Aborted", "AbortError")),
      { once: true },
    );

    link.onOpen = () => {
      void claimPath(opts.code, "direct")
        .then((path) => {
          if (path === "direct") {
            opts.onLog(`Path locked · ${link.tunnel.label}.`);
            succeed(link.tunnel);
          } else {
            link.close();
            opts.onLog("Path locked · encrypted relay.");
            succeed(createRelayTunnel(opts.code, opts.role, opts.signal));
          }
        })
        .catch((error) => fail(error instanceof Error ? error : new Error("Couldn't choose a path.")));
    };

    link.start();
    opts.onLog(opts.lanOnly ? "Looking for a local or direct network path." : "Negotiating direct WebRTC data path.");

    timer = setTimeout(() => {
      void claimPath(opts.code, "relay")
        .then((path) => {
          if (settled) return;
          if (path === "relay") {
            link.close();
            opts.onLog("Direct path timed out. Falling back to encrypted relay (max 25 MB).");
            succeed(createRelayTunnel(opts.code, opts.role, opts.signal));
            return;
          }
          opts.onLog("The other side took the direct path. Joining it.");
          extra = setTimeout(() => {
            if (!settled) {
              fail(new Error("The direct path was chosen, but this device couldn't join it. Try again."));
            }
          }, 6000);
        })
        .catch((error) => fail(error instanceof Error ? error : new Error("Couldn't choose a path.")));
    }, opts.lanOnly ? 8000 : 10000);
  });
}

function attachAbort(pipe: SecurePipe, signal: AbortSignal) {
  const close = () => {
    try {
      void pipe.sendControl({ t: "cancel", reason: "Connection closed by user." });
    } catch {
      // The pipe may already be closed; teardown must continue regardless.
    }
    pipe.close();
  };
  if (signal.aborted) {
    close();
    throw new DOMException("Aborted", "AbortError");
  }
  signal.addEventListener("abort", close, { once: true });
}

export function runHostSession(
  opts: CommonOpts & {
    files: File[];
    onRegisteredSender?: (sender: (newFiles: File[]) => Promise<void>) => void;
  },
) {
  void (async () => {
    let pipe: SecurePipe | null = null;
    try {
      opts.onEvent({ type: "log", line: "Waiting for the passcode to be entered." });
      const guestKey = await waitForGuestKey(opts.code, opts.signal);
      opts.onEvent({ type: "log", line: "Receiver joined. Deriving the session key." });
      const tunnel = await openTunnel({
        code: opts.code,
        role: "host",
        lanOnly: opts.mode === "lan",
        signal: opts.signal,
        onLog: (line) => opts.onEvent({ type: "log", line }),
      });

      if (opts.mode === "lan" && tunnel.isLocal === false) {
        opts.onEvent({
          type: "log",
          line: "Notice: Connection is not on local network (remote candidate). Host fingerprint verification is required.",
        });
      }

      opts.onEvent({ type: "path", label: tunnel.label });
      const aes = await deriveSessionKey(opts.privateKey, guestKey, opts.code);
      pipe = new SecurePipe(tunnel, aes);
      attachAbort(pipe, opts.signal);
      opts.onEvent({ type: "log", line: "cipher: aes256-gcm · kex: ecdh-sha2-nistp256" });
      await pipe.sendControl({ t: "proof", token: opts.code });
      const reply = await pipe.waitControl(opts.signal);
      if (reply.t !== "proof-ok") throw new Error("The receiver didn't accept the session.");
      opts.onEvent({ type: "log", line: "Host key accepted. Channel open." });
      opts.onEvent({ type: "verified" });

      let currentFileIndex = 0;

      const sendBatch = async (batchFiles: File[]) => {
        if (!pipe) throw new Error("Session pipe is closed.");
        if (!batchFiles.length) return;

        const grand = batchFiles.reduce((sum, file) => sum + file.size, 0);

        // Check if relay path can carry this transfer
        if (pipe.label.toLowerCase().includes("relay") && grand > RELAY_CAP_BYTES) {
          throw new Error(
            `Encrypted relay fallback is limited to 25 MB. Cannot send ${formatBytes(grand)} over relay. Connect directly via WebRTC for up to 10 GB.`,
          );
        }

        let sentTotal = 0;
        for (let idx = 0; idx < batchFiles.length; idx += 1) {
          const file = batchFiles[idx];
          const fileIdx = currentFileIndex;
          currentFileIndex += 1;

          opts.onEvent({ type: "log", line: `Sending ${file.name} (${formatBytes(file.size)})` });
          await pipe.sendControl({
            t: "file",
            i: fileIdx,
            name: file.name,
            size: file.size,
            mime: file.type || "application/octet-stream",
          });

          // Wait for receiver to indicate readiness (buffer allocated or disk file stream opened)
          const ready = await pipe.waitControl(opts.signal);
          if (ready.t === "cancel") throw new Error(ready.reason);
          if (ready.t !== "file-ready" || ready.i !== fileIdx) {
            throw new Error(`Receiver wasn't ready to receive ${file.name}.`);
          }

          const sha = new Sha256();
          let offset = 0;
          while (offset < file.size) {
            if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const sliceEnd = Math.min(offset + CHUNK_BYTES, file.size);
            const buf = new Uint8Array(await file.slice(offset, sliceEnd).arrayBuffer());
            sha.update(buf);
            await pipe.sendChunk(buf);
            offset += buf.length;
            sentTotal += buf.length;
            opts.onEvent({
              type: "progress",
              name: file.name,
              index: fileIdx,
              sent: offset,
              size: file.size,
              sentTotal,
              grand,
            });
          }

          await pipe.sendControl({ t: "file-end", i: fileIdx, sha256: sha.hex() });

          // Wait for receiver integrity check ACK
          const ack = await pipe.waitControl(opts.signal);
          if (ack.t === "cancel") throw new Error(ack.reason);
          if (ack.t !== "file-ack" || ack.i !== fileIdx || ack.sha256 !== sha.hex()) {
            throw new Error(`${file.name} failed integrity acknowledgment from receiver.`);
          }

          opts.onEvent({ type: "log", line: `Sealed ${file.name} · sha256 ${sha.hex().slice(0, 12)} (verified by peer)` });
        }

        await pipe.sendControl({ t: "batch-complete" });
        opts.onEvent({
          type: "log",
          line: `Batch transferred successfully. Session remains open to send more files.`,
        });
        opts.onEvent({ type: "batch-complete" });
      };

      opts.onEvent({ type: "ready-for-files", sendBatch });
      opts.onRegisteredSender?.(sendBatch);

      // Send initial files
      if (opts.files.length) {
        await sendBatch(opts.files);
      }

      // Keep host session alive until user closes or signal aborts
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) resolve();
        else opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } catch (error) {
      if (opts.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      opts.onEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Transfer failed.",
      });
    }
  })();
}

export function runGuestSession(
  opts: CommonOpts & {
    hostKey: PublicJwk;
    publicJwk: PublicJwk;
    expectedTotal: number;
    /** Max total bytes this receiver will accept. Defaults to MAX_BYTES (10 GB). */
    receiverQuota?: number;
    requestSaveStream?: (file: { name: string; size: number }) => Promise<FileSystemWritableFileStream | null>;
  },
) {
  void (async () => {
    let pipe: SecurePipe | null = null;
    try {
      await publishGuestKey(opts.code, opts.publicJwk);
      opts.onEvent({ type: "log", line: "Guest key published. Opening the session." });
      const tunnel = await openTunnel({
        code: opts.code,
        role: "guest",
        lanOnly: opts.mode === "lan",
        signal: opts.signal,
        onLog: (line) => opts.onEvent({ type: "log", line }),
      });

      if (opts.mode === "lan" && tunnel.isLocal === false) {
        opts.onEvent({
          type: "log",
          line: "Notice: Connection is not on local network (remote candidate). Host fingerprint comparison required.",
        });
      }

      opts.onEvent({ type: "path", label: tunnel.label });
      const aes = await deriveSessionKey(opts.privateKey, opts.hostKey, opts.code);
      pipe = new SecurePipe(tunnel, aes);
      attachAbort(pipe, opts.signal);
      const proof = await pipe.waitControl(opts.signal);
      if (proof.t !== "proof" || proof.token !== opts.code) {
        throw new Error("The session proof didn't match this passcode.");
      }
      await pipe.sendControl({ t: "proof-ok" });
      opts.onEvent({ type: "log", line: "Host key matched. Channel open." });
      opts.onEvent({ type: "verified" });

      const grand = opts.expectedTotal;
      let sentTotal = 0;

      for (;;) {
        const message = await pipe.waitControl(opts.signal);
        if (message.t === "complete") {
          opts.onEvent({ type: "complete" });
          break;
        }
        if (message.t === "cancel") {
          opts.onEvent({ type: "error", message: `Transfer cancelled: ${message.reason}` });
          throw new Error(message.reason);
        }
        if (message.t === "batch-complete") {
          opts.onEvent({
            type: "log",
            line: "Batch transfer complete. Session remains open for more files.",
          });
          opts.onEvent({ type: "batch-complete" });
          continue;
        }
        if (message.t !== "file") {
          throw new Error("Unexpected message received from sender.");
        }

        // Treat all peer-supplied file metadata as hostile even after the encrypted
        // channel is established. Encryption authenticates the peer, not its intent.
        if (
          !Number.isSafeInteger(message.i) || message.i < 0 ||
          !Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_BYTES ||
          typeof message.name !== "string" || message.name.length > 1024 ||
          typeof message.mime !== "string" || message.mime.length > 256
        ) {
          throw new Error("The sender provided invalid file metadata.");
        }
        if (sentTotal + message.size > MAX_BYTES) {
          throw new Error("The transfer exceeds Peakline's maximum session size.");
        }

        const rawName = message.name;
        // Sanitize filename before any disk or memory operation.
        const { safe: safeName, warning: fileWarning } = sanitizeFileName(rawName);

        // If the file type is dangerous, pause and require the receiver to explicitly accept.
        if (fileWarning) {
          const accepted = await new Promise<boolean>((resolve) => {
            opts.onEvent({
              type: "file-warning",
              safeName,
              rawName,
              warning: fileWarning,
              respond: resolve,
            });
          });
          if (!accepted) {
            const reason = `Receiver rejected file "${safeName}" (dangerous file type).`;
            await pipe.sendControl({ t: "cancel", reason });
            throw new Error(reason);
          }
        }

        const file = { ...message, name: safeName };
        let writableStream: FileSystemWritableFileStream | null = null;
        let isDiskStream = false;

        // Stream to disk with File System Access API when available, or buffer in memory up to MEMORY_THRESHOLD_BYTES
        const hasDiskPicker = typeof window !== "undefined" && "showSaveFilePicker" in window;

        if (hasDiskPicker) {
          // Stream directly to disk when supported
          if (opts.requestSaveStream) {
            writableStream = await opts.requestSaveStream(file);
          } else {
            try {
              const handle = await (window as unknown as { showSaveFilePicker: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
                suggestedName: file.name,
              });
              writableStream = await handle.createWritable();
            } catch {
              const errMsg = `Disk save location was not selected for ${file.name}.`;
              await pipe.sendControl({ t: "cancel", reason: errMsg });
              throw new Error(errMsg);
            }
          }

          if (writableStream) {
            isDiskStream = true;
            opts.onEvent({
              type: "log",
              line: `Streaming ${file.name} (${formatBytes(file.size)}) directly to disk.`,
            });
          }
        } else if (file.size > MEMORY_THRESHOLD_BYTES) {
          // If disk streaming is unsupported AND file exceeds safe memory threshold (512 MB)
          const err = `File "${file.name}" (${formatBytes(file.size)}) exceeds browser memory capacity (${formatBytes(MEMORY_THRESHOLD_BYTES)}) and disk streaming (File System Access API) is not supported in this browser. Please use Chrome/Edge or send files under ${formatBytes(MEMORY_THRESHOLD_BYTES)}.`;
          await pipe.sendControl({ t: "cancel", reason: err });
          throw new Error(err);
        }

        // Notify sender that receiver is ready to receive file chunks
        await pipe.sendControl({ t: "file-ready", i: file.i });

        const parts: Uint8Array[] = [];
        let got = 0;
        const sha = new Sha256();

        pipe.onChunk = (chunk) => {
          // Enforce declared per-file and aggregate caps against actual received
          // bytes. A malicious sender cannot bypass limits by lying in metadata.
          if (got + chunk.length > file.size || sentTotal + chunk.length > MAX_BYTES) {
            throw new Error("Received data exceeded the authorized transfer size.");
          }
          got += chunk.length;
          sha.update(chunk);
          sentTotal += chunk.length;

          if (isDiskStream && writableStream) {
            void (writableStream as unknown as { write: (data: unknown) => Promise<void> }).write(chunk);
          } else {
            parts.push(chunk);
          }

          opts.onEvent({
            type: "progress",
            name: file.name,
            index: file.i,
            sent: got,
            size: file.size,
            sentTotal,
            grand: Math.max(grand, sentTotal),
          });
        };

        const end = await pipe.waitControl(opts.signal);
        pipe.onChunk = () => {
          throw new Error("A file chunk arrived outside a file.");
        };

        if (end.t !== "file-end" || end.i !== file.i || end.sha256 !== sha.hex()) {
          if (writableStream) {
            try {
              await writableStream.abort();
            } catch {
              // Best-effort cleanup; preserve the integrity failure as the primary error.
            }
          }
          throw new Error(`${file.name} failed the integrity check.`);
        }

        if (isDiskStream && writableStream) {
          await writableStream.close();
          await pipe.sendControl({ t: "file-ack", i: file.i, sha256: sha.hex() });
          opts.onEvent({
            type: "file",
            name: file.name,
            size: file.size,
            mime: file.mime,
            url: "",
            diskStreamed: true,
          });
          opts.onEvent({ type: "log", line: `Received and saved ${file.name} to disk (verified sha256)` });
        } else {
          // Buffered in memory into a single Blob (without redundant copies)
          const blob = new Blob(parts as BlobPart[], { type: file.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          await pipe.sendControl({ t: "file-ack", i: file.i, sha256: sha.hex() });
          opts.onEvent({
            type: "file",
            name: file.name,
            size: file.size,
            mime: file.mime,
            url,
            diskStreamed: false,
          });
          opts.onEvent({ type: "log", line: `Received ${file.name} (verified sha256)` });
        }
      }
    } catch (error) {
      if (opts.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      opts.onEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Transfer failed.",
      });
    }
  })();
}

export async function endRoom(code: string) {
  await closeRoom(code);
}
