import { openSeal, seal } from "@/lib/share/crypto";

export type Control =
  | { t: "proof"; token: string }
  | { t: "proof-ok" }
  | { t: "manifest"; files: { name: string; size: number; mime: string }[] }
  | { t: "file"; i: number; name: string; size: number; mime: string }
  | { t: "file-ready"; i: number }
  | { t: "file-end"; i: number; sha256: string }
  | { t: "file-ack"; i: number; sha256: string }
  | { t: "batch-complete" }
  | { t: "complete" }
  | { t: "cancel"; reason: string };

export interface Tunnel {
  label: string;
  isLocal?: boolean;
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
  setHandler(handler: (bytes: Uint8Array) => void): void;
}

type Waiter = {
  resolve: (message: Control) => void;
  reject: (error: Error) => void;
};

/** Maximum number of control messages that may be queued before being consumed. */
const MAX_PENDING_CONTROLS = 64;

export class SecurePipe {
  onChunk: (chunk: Uint8Array) => void = () => {
    this.fail(new Error("A file chunk arrived before its header."));
  };
  private outSeq = 0;
  private inSeq = 0;
  private controls: Control[] = [];
  private waiters: Waiter[] = [];
  private error: Error | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly tunnel: Tunnel,
    private readonly key: CryptoKey,
  ) {
    this.tunnel.setHandler((bytes) => {
      this.chain = this.chain.then(() => this.handle(bytes)).catch((err) => this.fail(err));
    });
  }

  get label() {
    return this.tunnel.label;
  }

  close() {
    this.tunnel.close();
  }

  async sendControl(message: Control) {
    const json = new TextEncoder().encode(JSON.stringify(message));
    const plain = new Uint8Array(1 + json.length);
    plain[0] = 0;
    plain.set(json, 1);
    await this.sendPlain(plain);
  }

  async sendChunk(chunk: Uint8Array) {
    const plain = new Uint8Array(1 + chunk.length);
    plain[0] = 1;
    plain.set(chunk, 1);
    await this.sendPlain(plain);
  }

  waitControl(signal: AbortSignal): Promise<Control> {
    if (this.error) return Promise.reject(this.error);
    const queued = this.controls.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolveWrapped);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const resolveWrapped = (message: Control) => {
        signal.removeEventListener("abort", onAbort);
        resolve(message);
      };
      const rejectWrapped = (error: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push({ resolve: resolveWrapped, reject: rejectWrapped });
    });
  }

  private async sendPlain(plain: Uint8Array) {
    if (this.error) throw this.error;
    const seq = this.outSeq;
    this.outSeq += 1;
    await this.tunnel.send(await seal(this.key, plain, seq));
  }

  private async handle(packet: Uint8Array) {
    if (this.error) return;
    let opened: { seq: number; plain: Uint8Array };
    try {
      opened = await openSeal(this.key, packet);
    } catch {
      throw new Error("Couldn't decrypt the session. The host key may not match.");
    }
    if (opened.seq !== this.inSeq) throw new Error("The session stream skipped a packet.");
    this.inSeq += 1;
    if (opened.plain[0] === 0) {
      let message: Control;
      try {
        message = JSON.parse(new TextDecoder().decode(opened.plain.subarray(1))) as Control;
      } catch {
        throw new Error("The session sent a message that couldn't be read.");
      }
      if (message.t === "cancel") {
        this.fail(new Error(message.reason));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        // Guard against unbounded control queue growth (DoS from a malicious peer)
        if (this.controls.length >= MAX_PENDING_CONTROLS) {
          throw new Error("Too many unread control messages from peer.");
        }
        this.controls.push(message);
      }
      return;
    }
    if (opened.plain[0] === 1) {
      this.onChunk(opened.plain.subarray(1));
      return;
    }
    throw new Error("The session sent an unknown frame.");
  }

  private fail(err: unknown) {
    if (this.error) return;
    const error = err instanceof Error ? err : new Error("The session failed.");
    this.error = error;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }
}
