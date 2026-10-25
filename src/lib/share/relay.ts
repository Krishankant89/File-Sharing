import type { Tunnel } from "@/lib/share/secure-pipe";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createRelayTunnel(code: string, role: "host" | "guest", signal: AbortSignal): Tunnel {
  const other = role === "host" ? "guest" : "host";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inbox: Uint8Array[] = [];
  let handler: ((bytes: Uint8Array) => void) | null = null;
  const tunnel: Tunnel = {
    label: "Encrypted relay (max 25 MB)",
    isLocal: false,
    send: async (bytes) => {
      if (closed) throw new Error("The relay closed.");
      const body = bytesToBase64(bytes);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (signal.aborted || closed) throw new DOMException("Aborted", "AbortError");
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "relay-put", code, to: other, body }),
        });
        if (res.status === 429) {
          const delay = Math.min(1000, 80 * Math.pow(1.2, attempt));
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errData.error || "The encrypted relay couldn't take a packet.");
        }
        return;
      }
      throw new Error("The encrypted relay is full. Direct connection is required for files larger than 25 MB.");
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
    setHandler: (next) => {
      handler = next;
      for (const bytes of inbox.splice(0)) next(bytes);
    },
  };

  const pump = async () => {
    if (closed || signal.aborted) return;
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "relay-take", code, role }),
      });
      if (res.ok) {
        const data = (await res.json()) as { messages?: { body: string }[] };
        for (const message of data.messages ?? []) {
          const bytes = base64ToBytes(message.body);
          if (handler) handler(bytes);
          else inbox.push(bytes);
        }
      }
    } catch {
      // Next tick retries.
    }
    timer = setTimeout(() => void pump(), 140);
  };
  void pump();
  return tunnel;
}
