export const MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB advertised cap
export const DIRECT_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB WebRTC direct path
export const RELAY_CAP_BYTES = 25 * 1024 * 1024; // 25 MB encrypted relay fallback mailbox cap
export const MEMORY_THRESHOLD_BYTES = 512 * 1024 * 1024; // 512 MB memory threshold for browsers without File System Access API
export const MAX_FILES = 40;
export const CHUNK_BYTES = 64 * 1024; // 64 KB chunks

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatCode(code: string): string {
  if (code.length !== 10) return code;
  return `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`;
}

export function randomCode(): string {
  const digits: string[] = [];
  const buf = new Uint8Array(16);
  while (digits.length < 10) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= 250) continue;
      digits.push(String(byte % 10));
      if (digits.length === 10) break;
    }
  }
  return digits.join("");
}

export function cleanFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  return (cleaned || "file").slice(0, 180);
}

export function sampleFile(): File {
  const body = [
    "Peakline sample",
    `Created ${new Date().toISOString()}`,
    "This file crossed an encrypted session.",
    "Host key checked. AES-256-GCM. Passcode required.",
  ].join("\n");
  return new File([body], "peakline-sample.txt", { type: "text/plain" });
}
