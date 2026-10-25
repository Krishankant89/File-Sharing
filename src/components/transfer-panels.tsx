import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Download, Plus, Radio, ShieldAlert, Terminal, Upload, Wifi, X } from "lucide-react";
import { useStableSession } from "@/components/use-stable-session";
import { cn } from "@/lib/cn";
import {
  createRoom,
  fetchNearby,
  fetchRoom,
  resetGuestKey,
  type NearbyRoom,
  type ShareMode,
} from "@/lib/share/api";
import { fingerprintForJwk, generateRoomKeys, type PublicJwk } from "@/lib/share/crypto";
import { cleanFileName, formatBytes, formatCode, MAX_BYTES, randomCode, sampleFile } from "@/lib/share/format";
import { endRoom, runGuestSession, runHostSession, type SessionEvent } from "@/lib/share/session";

const modes: { id: ShareMode; title: string; copy: string; icon: typeof Wifi }[] = [
  {
    id: "ssh",
    title: "Verified P2P session",
    copy: "Fingerprint verification, AES-256-GCM cipher, and security transcript.",
    icon: Terminal,
  },
  {
    id: "lan",
    title: "Local network",
    copy: "Prefer a same-network direct path. The room is discoverable on this local network.",
    icon: Wifi,
  },
  {
    id: "remote",
    title: "Remote passcode",
    copy: "Direct WebRTC with TURN fallback for symmetric NATs.",
    icon: Radio,
  },
];

interface LiveState {
  logs: string[];
  path: string;
  verified: boolean;
  done: boolean;
  error: string | null;
  progress: { name: string; sent: number; size: number; sentTotal: number; grand: number } | null;
}

interface SavedFile {
  name: string;
  size: number;
  url: string;
  mime: string;
  diskStreamed?: boolean;
}

function applyEvent(current: LiveState, event: SessionEvent): LiveState {
  if (event.type === "log") return { ...current, logs: [...current.logs, event.line].slice(-24) };
  if (event.type === "path") return { ...current, path: event.label, logs: [...current.logs, event.label].slice(-24) };
  if (event.type === "verified") return { ...current, verified: true };
  if (event.type === "progress") {
    return {
      ...current,
      progress: {
        name: event.name,
        sent: event.sent,
        size: event.size,
        sentTotal: event.sentTotal,
        grand: event.grand,
      },
    };
  }
  if (event.type === "batch-complete") {
    return { ...current, done: true, progress: null };
  }
  if (event.type === "complete") return { ...current, done: true };
  if (event.type === "error") return { ...current, error: event.message, logs: [...current.logs, event.message].slice(-24) };
  // file-warning is handled imperatively via its respond callback, not via LiveState
  return current;
}

interface FileWarningState {
  safeName: string;
  rawName: string;
  warning: string;
  respond: (accept: boolean) => void;
}

function FileWarningModal({ state, onDismiss }: { state: FileWarningState; onDismiss: () => void }) {
  const isDifferentName = state.rawName !== state.safeName;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-warning-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-paper p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="file-warning-title" className="text-base font-extrabold text-navy">
              Potentially Dangerous File
            </h2>
            <p className="mt-1 break-all text-sm font-semibold text-navy">
              &ldquo;{state.safeName}&rdquo;
            </p>
            {isDifferentName && (
              <p className="mt-1 text-xs text-muted">
                Original name: <span className="font-mono break-all">{state.rawName}</span>
              </p>
            )}
            <p className="mt-3 text-sm leading-6 text-muted">{state.warning}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            id="file-warning-accept"
            type="button"
            onClick={() => { state.respond(true); onDismiss(); }}
            className="inline-flex h-11 items-center justify-center rounded-md border border-amber-500 bg-amber-50 px-4 text-sm font-bold text-amber-800 hover:bg-amber-100"
          >
            <AlertTriangle className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Accept dangerous file
          </button>
          <button
            id="file-warning-reject"
            type="button"
            onClick={() => { state.respond(false); onDismiss(); }}
            className="inline-flex h-11 items-center justify-center rounded-md bg-navy px-4 text-sm font-bold text-paper hover:opacity-90"
          >
            Reject file
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Only accept if you know exactly what this file is and trust the sender.
        </p>
      </div>
    </div>
  );
}

function PasscodeReadout({ code }: { code: string }) {
  const chars = code.padEnd(10, " ").slice(0, 10).split("");
  return (
    <div className="grid grid-cols-5 gap-2 sm:grid-cols-10" aria-label={formatCode(code)}>
      {chars.map((char, index) => (
        <div
          key={index}
          className="flex h-12 items-center justify-center rounded-md border border-line bg-paper font-mono text-xl font-semibold text-navy tabular-nums"
        >
          {char.trim()}
        </div>
      ))}
    </div>
  );
}

function Transcript({ fingerprint, lines }: { fingerprint: string; lines: string[] }) {
  return (
    <div className="rounded-lg bg-navy-deep p-4 text-left font-mono text-xs leading-6 text-foam sm:text-sm" aria-live="polite">
      <p>Peakline Secure P2P</p>
      <p>kex: ecdh-sha2-nistp256</p>
      <p>cipher: aes256-gcm · auth: implicit</p>
      <p className="text-sand break-all">host key {fingerprint || "pending"}</p>
      {lines.map((line, index) => (
        <p key={`${index}-${line}`} className="break-all">
          {line}
        </p>
      ))}
      <p>
        <span className="peak-caret text-sand">█</span>
      </p>
    </div>
  );
}

function ProgressBar({ progress }: { progress: LiveState["progress"] }) {
  if (!progress || progress.grand <= 0) return null;
  const pct = Math.min(100, Math.round((progress.sentTotal / progress.grand) * 100));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold text-navy">
        <span className="min-w-0 truncate">{progress.name}</span>
        <span className="shrink-0 tabular-nums">
          {formatBytes(progress.sentTotal)} / {formatBytes(progress.grand)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-action" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function HostPanel() {
  const [mode, setMode] = useState<ShareMode>("ssh");
  const [hostName, setHostName] = useState("My device");
  const [files, setFiles] = useState<File[]>([]);
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [showGuest, setShowGuest] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [sendingExtra, setSendingExtra] = useState(false);
  const [live, setLive] = useState<LiveState>({
    logs: [],
    path: "Waiting",
    verified: false,
    done: false,
    error: null,
    progress: null,
  });

  const sendBatchRef = useRef<((newFiles: File[]) => Promise<void>) | null>(null);
  const launch = useRef<{
    code: string;
    mode: ShareMode;
    privateKey: CryptoKey;
    files: File[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const extraInputRef = useRef<HTMLInputElement>(null);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const locked = runId != null;

  useStableSession(runId, (signal) => {
    const job = launch.current;
    if (!job) return;
    runHostSession({
      code: job.code,
      mode: job.mode,
      privateKey: job.privateKey,
      files: job.files,
      signal,
      onRegisteredSender: (sender) => {
        sendBatchRef.current = sender;
      },
      onEvent: (event) => {
        if (event.type === "ready-for-files") {
          sendBatchRef.current = event.sendBatch;
        }
        setLive((current) => applyEvent(current, event));
      },
    });
  });

  function addFiles(list: FileList | File[]) {
    if (locked) return;
    const next = [...files];
    let rejected = false;
    for (const file of list) {
      const named = new File([file], cleanFileName(file.name), { type: file.type });
      if (next.reduce((sum, item) => sum + item.size, 0) + named.size > MAX_BYTES || next.length >= 40) {
        rejected = true;
        break;
      }
      next.push(named);
    }
    setFiles(next);
    setNotice(rejected ? "Peakline sends up to 10 GB, and at most 40 files, per passcode." : null);
  }

  function addExtraFiles(list: FileList | File[]) {
    const next = [...extraFiles];
    let rejected = false;
    for (const file of list) {
      const named = new File([file], cleanFileName(file.name), { type: file.type });
      if (next.reduce((sum, item) => sum + item.size, 0) + named.size > MAX_BYTES || next.length >= 40) {
        rejected = true;
        break;
      }
      next.push(named);
    }
    setExtraFiles(next);
    setNotice(rejected ? "Peakline sends up to 10 GB per batch." : null);
  }

  async function sendMoreFiles() {
    if (!extraFiles.length || !sendBatchRef.current) return;
    setSendingExtra(true);
    setNotice(null);
    try {
      await sendBatchRef.current(extraFiles);
      setExtraFiles([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't send additional files.");
    } finally {
      setSendingExtra(false);
    }
  }

  async function start() {
    setNotice(null);
    if (!files.length) {
      setNotice("Add a file first. A passcode can carry up to 10 GB.");
      return;
    }
    const name = hostName.trim();
    if (!name) {
      setNotice("Name this device so the other person knows who is sending.");
      return;
    }
    const keys = await generateRoomKeys();
    const print = await fingerprintForJwk(keys.publicJwk);
    let created = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = randomCode();
      try {
        await createRoom({
          code: candidate,
          mode,
          hostName: name,
          publicKey: keys.publicJwk,
          fileCount: files.length,
          totalBytes: total,
        });
        created = candidate;
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 409 || attempt === 4) {
          setNotice(error instanceof Error ? error.message : "Could not open a room.");
          return;
        }
      }
    }
    launch.current = { code: created, mode, privateKey: keys.privateKey, files };
    setCode(created);
    setFingerprint(print);
    setLive({
      logs: ["Session key ready.", "Read the host key to the other person before they continue."],
      path: "Waiting for the passcode",
      verified: false,
      done: false,
      error: null,
      progress: null,
    });
    setRunId((value) => (value ?? 0) + 1);
  }

  async function copy(kind: "code" | "link") {
    if (!code) return;
    const path = window.location.pathname.replace(/\/send\/?$/, "/receive");
    // Use URL hash fragment (#code=...) instead of query parameters to avoid server access logs and HTTP Referer leaks
    const value = kind === "code" ? code : `${window.location.origin}${path}#code=${code}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setNotice("Copy didn't succeed. Read the passcode from the screen.");
    }
  }

  function cancel() {
    if (code) void endRoom(code);
    launch.current = null;
    sendBatchRef.current = null;
    setRunId(null);
    setShowGuest(false);
    setLive((current) => ({ ...current, logs: [...current.logs, "Passcode closed."] }));
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1.15fr_0.85fr]">
      <section className="rounded-lg border border-line bg-paper p-5 sm:p-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-navy">Send up to 10 GB</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Drop the files, pick a path, and share the passcode. The receiver has to accept your host key before anything is readable.
        </p>
        <label className="mt-5 block text-sm font-bold text-navy" htmlFor="device-name">
          Your name on this transfer
        </label>
        <input
          id="device-name"
          value={hostName}
          disabled={locked}
          onChange={(event) => setHostName(event.target.value.slice(0, 32))}
          className="mt-2 h-11 w-full rounded-md border border-line bg-paper px-3 text-base text-ink"
        />
        <p className="mt-5 text-sm font-bold text-navy">How they connect</p>
        <div className="mt-2 grid gap-2" role="radiogroup" aria-label="Connection mode">
          {modes.map((item) => {
            const Icon = item.icon;
            const selected = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={locked}
                onClick={() => setMode(item.id)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-3 py-3 text-left",
                  selected ? "border-navy bg-mist" : "border-line bg-paper",
                )}
              >
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-action" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-bold text-navy">{item.title}</span>
                  <span className="mt-1 block text-sm leading-5 text-muted">{item.copy}</span>
                </span>
              </button>
            );
          })}
        </div>

        {!locked ? (
          <div
            className="mt-5 rounded-lg border border-dashed border-line bg-mist px-4 py-6 text-center"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              addFiles(event.dataTransfer.files);
            }}
          >
            <Upload className="mx-auto h-6 w-6 text-action" aria-hidden="true" />
            <p className="mt-2 text-sm font-bold text-navy">Drop files here</p>
            <p className="mt-1 text-sm text-muted">{formatBytes(total)} of 10 GB</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="inline-flex h-11 items-center rounded-md bg-navy px-4 text-sm font-bold text-paper hover:opacity-90 disabled:opacity-50"
                onClick={() => inputRef.current?.click()}
                disabled={locked}
              >
                Choose files
              </button>
              <button
                id="sample-file"
                type="button"
                className="inline-flex h-11 items-center rounded-md border border-line bg-paper px-4 text-sm font-bold text-navy hover:bg-mist disabled:opacity-50"
                onClick={() => addFiles([sampleFile()])}
                disabled={locked}
              >
                Use a sample
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        ) : null}

        {files.length && !locked ? (
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-navy">{file.name}</p>
                  <p className="text-xs text-muted tabular-nums">{formatBytes(file.size)}</p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md text-navy hover:bg-mist disabled:opacity-40"
                  aria-label={`Remove ${file.name}`}
                  disabled={locked}
                  onClick={() => setFiles(files.filter((_, item) => item !== index))}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Share more files in the same active session */}
        {locked && live.verified ? (
          <div className="mt-6 rounded-lg border border-action/40 bg-mist p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-navy">Share more files in this session</h3>
              <span className="rounded-full bg-sand px-2.5 py-0.5 text-xs font-bold text-navy">Session Active</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Add more files to transmit directly over the existing encrypted connection without a new passcode.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex h-10 items-center gap-1.5 rounded-md bg-navy px-3 text-xs font-bold text-paper hover:opacity-90 disabled:opacity-50"
                onClick={() => extraInputRef.current?.click()}
                disabled={sendingExtra}
              >
                <Plus className="h-4 w-4" />
                Add more files
              </button>
              <button
                type="button"
                className="inline-flex h-10 items-center rounded-md border border-line bg-paper px-3 text-xs font-bold text-navy hover:bg-mist disabled:opacity-50"
                onClick={() => addExtraFiles([sampleFile()])}
                disabled={sendingExtra}
              >
                Add sample file
              </button>
              <input
                ref={extraInputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files) addExtraFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {extraFiles.length ? (
              <div className="mt-3">
                <ul className="divide-y divide-line rounded-md border border-line bg-paper">
                  {extraFiles.map((file, idx) => (
                    <li key={`${file.name}-${idx}`} className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="truncate font-semibold text-navy">{file.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-muted">{formatBytes(file.size)}</span>
                        <button
                          type="button"
                          className="text-navy hover:opacity-60"
                          onClick={() => setExtraFiles(extraFiles.filter((_, i) => i !== idx))}
                          disabled={sendingExtra}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => void sendMoreFiles()}
                  disabled={sendingExtra}
                  className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-md bg-action text-sm font-bold text-paper hover:opacity-90 disabled:opacity-50"
                >
                  {sendingExtra ? "Sending files..." : `Send ${extraFiles.length} file(s) in this session`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {notice ? <p className="mt-3 text-sm font-semibold text-navy">{notice}</p> : null}
        {!code ? (
          <button
            id="create-passcode"
            type="button"
            onClick={() => void start()}
            className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-md bg-action text-base font-bold text-paper hover:opacity-90 sm:w-auto sm:px-6"
          >
            Create 10-digit passcode
          </button>
        ) : null}
      </section>

      <aside className="rounded-lg border border-line bg-paper p-5 sm:p-6">
        {!code ? (
          <div>
            <h2 className="text-xl font-extrabold text-navy">The room opens here</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              You will get a passcode and a host-key fingerprint. The other person compares that fingerprint before trusting the connection.
            </p>
          </div>
        ) : (
          <div data-status={live.done ? "complete" : live.verified ? "live" : "waiting"}>
            <p className="text-sm font-bold text-action">Passcode · {mode === "lan" ? "local network" : mode === "ssh" ? "verified session" : "remote"}</p>
            <h2 className="mt-1 text-xl font-extrabold text-navy">{formatCode(code)}</h2>
            <div className="mt-4">
              <PasscodeReadout code={code} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy("code")}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-sand px-4 text-sm font-bold text-navy"
              >
                {copied === "code" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copy passcode
              </button>
              <button
                type="button"
                onClick={() => void copy("link")}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-line px-4 text-sm font-bold text-navy"
              >
                {copied === "link" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copy join link
              </button>
            </div>
            <p className="mt-4 text-sm leading-6 text-muted">
              Path: <span className="font-bold text-navy">{live.path}</span>
            </p>
            <div className="mt-3">
              <ProgressBar progress={live.progress} />
            </div>
            {live.error ? <p className="mt-3 text-sm font-semibold text-navy">{live.error}</p> : null}
            {live.done ? (
              <p className="mt-3 text-sm font-bold text-navy">
                Batch complete. The session remains open so you can share more files or close the passcode.
              </p>
            ) : null}
            <div className="mt-4">
              <Transcript fingerprint={fingerprint} lines={live.logs} />
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                id="open-receiver"
                type="button"
                className="inline-flex h-11 items-center justify-center rounded-md bg-navy px-4 text-sm font-bold text-paper"
                onClick={() => setShowGuest(true)}
              >
                Open a receiver on this screen
              </button>
              <button
                type="button"
                className="inline-flex h-11 items-center justify-center rounded-md border border-line px-4 text-sm font-bold text-navy"
                onClick={cancel}
              >
                Close passcode
              </button>
            </div>
          </div>
        )}
      </aside>
      {showGuest && code ? (
        <div className="lg:col-span-2">
          <GuestPanel initialCode={code} embedded />
        </div>
      ) : null}
    </div>
  );
}

export function GuestPanel({ initialCode = "", embedded = false }: { initialCode?: string; embedded?: boolean }) {
  const [digits, setDigits] = useState(initialCode.replace(/\D/g, "").slice(0, 10));
  const [nearby, setNearby] = useState<NearbyRoom[]>([]);
  const [roomName, setRoomName] = useState("");
  const [roomMode, setRoomMode] = useState<ShareMode>("ssh");
  const [roomFileCount, setRoomFileCount] = useState(1);
  const [roomTotalBytes, setRoomTotalBytes] = useState(0);
  const [hostKey, setHostKey] = useState<PublicJwk | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [phase, setPhase] = useState<"enter" | "confirm" | "live">("enter");
  const [notice, setNotice] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  const [live, setLive] = useState<LiveState>({
    logs: [],
    path: "Waiting",
    verified: false,
    done: false,
    error: null,
    progress: null,
  });
  const [saved, setSaved] = useState<SavedFile[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileWarning, setFileWarning] = useState<FileWarningState | null>(null);
  const launch = useRef<{
    code: string;
    mode: ShareMode;
    privateKey: CryptoKey;
    publicJwk: PublicJwk;
    hostKey: PublicJwk;
    expectedTotal: number;
  } | null>(null);

  useStableSession(runId, (signal) => {
    const job = launch.current;
    if (!job) return;
    runGuestSession({
      code: job.code,
      mode: job.mode,
      privateKey: job.privateKey,
      publicJwk: job.publicJwk,
      hostKey: job.hostKey,
      expectedTotal: job.expectedTotal,
      signal,
      requestSaveStream: async (file) => {
        if (typeof window === "undefined" || !("showSaveFilePicker" in window)) {
          return null;
        }
        try {
          const handle = await (window as unknown as { showSaveFilePicker: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
            suggestedName: file.name,
          });
          return await handle.createWritable();
        } catch {
          return null;
        }
      },
      onEvent: (event) => {
        if (event.type === "file-warning") {
          // Show blocking modal; session.ts awaits the respond() callback.
          setFileWarning({
            safeName: event.safeName,
            rawName: event.rawName,
            warning: event.warning,
            respond: event.respond,
          });
          return;
        }
        if (event.type === "file") {
          setSaved((items) => [
            ...items,
            {
              name: event.name,
              size: event.size,
              url: event.url,
              mime: event.mime,
              diskStreamed: event.diskStreamed,
            },
          ]);
          if (event.url && event.mime.startsWith("text/") && event.size < 80_000) {
            void fetch(event.url)
              .then((res) => res.text())
              .then((text) => setPreview(text))
              .catch(() => {});
          }
        }
        setLive((current) => applyEvent(current, event));
      },
    });
  });

  useEffect(() => {
    if (phase !== "enter" || embedded) return;
    let stop = false;
    const tick = () => {
      void fetchNearby()
        .then((rooms) => {
          if (!stop) setNearby(rooms);
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [phase, embedded]);

  useEffect(() => {
    if (initialCode.length === 10) void lookup(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function lookup(raw: string) {
    const code = raw.replace(/\D/g, "").slice(0, 10);
    setDigits(code);
    if (code.length !== 10) {
      setNotice("The passcode is 10 digits.");
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    try {
      const room = await fetchRoom(code);
      if (!room) {
        setNotice("That passcode isn't active.");
        setPhase("enter");
        return;
      }
      if (room.guestKey) {
        setNotice("Someone already joined this passcode.");
        return;
      }
      const print = await fingerprintForJwk(room.publicKey);
      setHostKey(room.publicKey);
      setFingerprint(print);
      setRoomName(room.hostName);
      setRoomMode(room.mode);
      setRoomFileCount(room.fileCount);
      setRoomTotalBytes(room.totalBytes);
      setPhase("confirm");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't open that passcode.");
    } finally {
      setLookupBusy(false);
    }
  }

  async function handleRetryJoin() {
    if (digits.length !== 10) return;
    setLookupBusy(true);
    try {
      await resetGuestKey(digits);
      await lookup(digits);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't reset session for retry.");
    } finally {
      setLookupBusy(false);
    }
  }

  async function accept() {
    if (!hostKey || digits.length !== 10) return;
    const keys = await generateRoomKeys();
    launch.current = {
      code: digits,
      mode: roomMode,
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
      hostKey,
      expectedTotal: roomTotalBytes,
    };
    setLive({
      logs: ["Host key accepted locally.", "Publishing the guest key."],
      path: "Connecting",
      verified: false,
      done: false,
      error: null,
      progress: null,
    });
    setSaved([]);
    setPreview(null);
    setPhase("live");
    setRunId((value) => (value ?? 0) + 1);
  }

  return (
    <>
      <section className={cn("rounded-lg border border-line bg-paper p-5 sm:p-6", embedded && "bg-mist")}>
      <p className="text-sm font-bold text-action">{embedded ? "Receiver on this screen" : "Join a transfer"}</p>
      <h1 className={cn("mt-1 font-extrabold tracking-tight text-navy", embedded ? "text-2xl" : "text-3xl")}>
        {phase === "confirm" ? "Check the host key" : phase === "live" ? "Session" : "Enter the 10-digit passcode"}
      </h1>

      {phase === "enter" ? (
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup(digits);
          }}
        >
          <label htmlFor="passcode" className="text-sm font-bold text-navy">
            Passcode
          </label>
          <input
            id="passcode"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={digits}
            onChange={(event) => setDigits(event.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder="10 digits"
            className="mt-2 h-14 w-full rounded-md border border-line bg-paper px-3 text-center font-mono text-2xl font-semibold tracking-widest text-navy tabular-nums"
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={lookupBusy}
              className="inline-flex h-12 w-full items-center justify-center rounded-md bg-action text-base font-bold text-paper hover:opacity-90 disabled:opacity-50 sm:w-auto sm:px-6"
            >
              {lookupBusy ? "Checking…" : "Continue"}
            </button>
            {notice?.includes("already joined") ? (
              <button
                type="button"
                onClick={() => void handleRetryJoin()}
                disabled={lookupBusy}
                className="inline-flex h-12 items-center justify-center rounded-md border border-line bg-paper px-4 text-sm font-bold text-navy hover:bg-mist"
              >
                Reset & Retry Session
              </button>
            ) : null}
          </div>
          {notice ? <p className="mt-3 text-sm font-semibold text-navy">{notice}</p> : null}
          {!embedded && nearby.length ? (
            <div className="mt-6">
              <h2 className="text-sm font-bold text-navy">On this network</h2>
              <ul className="mt-2 grid gap-2">
                {nearby.map((room) => (
                  <li key={room.code}>
                    <button
                      type="button"
                      onClick={() => void lookup(room.code)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-3 text-left hover:bg-mist"
                    >
                      <span>
                        <span className="block text-sm font-bold text-navy">{room.hostName}</span>
                        <span className="text-xs text-muted">
                          {room.fileCount} files · {formatBytes(room.totalBytes)} · local network
                        </span>
                      </span>
                      <span className="font-mono text-sm font-bold text-navy tabular-nums">{formatCode(room.code)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-5 text-muted">
                Only rooms discoverable on this genuine local network are listed. The host fingerprint must be accepted before connecting.
              </p>
            </div>
          ) : null}
        </form>
      ) : null}

      {phase === "confirm" ? (
        <div className="mt-5">
          <p className="text-sm leading-6 text-muted">
            {roomName} wants to send {roomFileCount} file{roomFileCount === 1 ? "" : "s"} ({formatBytes(roomTotalBytes)}). Compare this host fingerprint before establishing the encrypted pipe.
          </p>
          <div className="mt-4 rounded-lg bg-navy p-4 font-mono text-sm leading-6 text-foam">
            <p>Peer identity check for host 'peakline-{digits}'</p>
            <p>P-256 ECDH host key fingerprint is</p>
            <p className="text-sand break-all">{fingerprint}</p>
            <p className="mt-2 text-xs text-foam/80">
              Confirm that this fingerprint matches the sender&apos;s display before connecting. File names and contents remain encrypted until you accept.
            </p>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              id="accept-host"
              type="button"
              onClick={() => void accept()}
              className="inline-flex h-12 items-center justify-center rounded-md bg-sand px-5 text-base font-bold text-navy"
            >
              Yes, connect
            </button>
            <button
              type="button"
              onClick={() => setPhase("enter")}
              className="inline-flex h-12 items-center justify-center rounded-md border border-line px-5 text-sm font-bold text-navy"
            >
              No, cancel
            </button>
          </div>
          {notice ? <p className="mt-3 text-sm font-semibold text-navy">{notice}</p> : null}
        </div>
      ) : null}

      {phase === "live" ? (
        <div className="mt-5" data-status={live.done ? "complete" : live.verified ? "live" : "connecting"}>
          <p className="text-sm leading-6 text-muted">
            Path: <span className="font-bold text-navy">{live.path}</span>
          </p>
          <div className="mt-3">
            <ProgressBar progress={live.progress} />
          </div>
          {live.error ? <p className="mt-3 text-sm font-semibold text-navy">{live.error}</p> : null}
          {saved.length ? (
            <ul className="mt-4 grid gap-3">
              {saved.map((file, idx) => (
                <li key={`${file.name}-${idx}`} className="rounded-lg border border-line bg-paper p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-navy">{file.name}</p>
                      <p className="text-xs text-muted tabular-nums">
                        {formatBytes(file.size)}
                        {file.diskStreamed ? " · Saved directly to disk (Verified SHA-256)" : ""}
                      </p>
                    </div>
                    {file.diskStreamed ? (
                      <span className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-sand px-3 text-xs font-bold text-navy">
                        <Check className="h-4 w-4" />
                        Saved to Disk
                      </span>
                    ) : (
                      <a
                        href={file.url}
                        download={file.name}
                        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-action px-4 text-sm font-bold text-paper"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download
                      </a>
                    )}
                  </div>
                  {file.url && file.mime.startsWith("image/") ? (
                    <img src={file.url} alt="" className="mt-3 max-h-48 rounded-md" />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {preview ? (
            <pre className="mt-4 overflow-auto rounded-lg bg-mist p-3 text-sm leading-6 text-ink whitespace-pre-wrap">{preview}</pre>
          ) : null}
          {live.done ? (
            <p className="mt-3 text-sm font-bold text-navy">
              Files received and verified. The session remains open for any additional files from the sender.
            </p>
          ) : null}
          <div className="mt-4">
            <Transcript fingerprint={fingerprint} lines={live.logs} />
          </div>
        </div>
      ) : null}
    </section>
    {fileWarning ? (
      <FileWarningModal
        state={fileWarning}
        onDismiss={() => setFileWarning(null)}
      />
    ) : null}
  </>
  );
}
