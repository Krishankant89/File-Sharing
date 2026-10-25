import { isIP } from "node:net";

/** Small server-side helpers for bounding untrusted HTTP input. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new RequestSizeError();
  }
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestSizeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}

export class RequestSizeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestSizeError";
  }
}

/**
 * Resolve a client address only when the deployment explicitly opts into a
 * trusted proxy header. Configure TRUSTED_PROXY_HOPS to the number of trusted
 * proxies that append to X-Forwarded-For; the edge must strip client-supplied
 * forwarding headers before appending its own. Otherwise use a shared
 * conservative identity rather than trusting attacker-controlled headers.
 */
export function clientAddressFromTrustedProxy(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS !== "true") {
    // Local single-process development has no reverse proxy to consult.
    return process.env.NODE_ENV === "production" ? "untrusted-proxy-identity" : "local";
  }

  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) return "untrusted-proxy-identity";

  const chain = request.headers.get("x-forwarded-for");
  if (!chain) return "untrusted-proxy-identity";
  const parts = chain.split(",").map((part) => part.trim());
  const index = parts.length - hops - 1;
  if (index < 0) return "untrusted-proxy-identity";
  const candidate = parts[index];
  if (!candidate || isIP(candidate) === 0) return "untrusted-proxy-identity";
  return candidate.toLowerCase();
}
