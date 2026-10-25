import type { PublicJwk } from "@/lib/share/crypto";

export type ShareMode = "remote" | "lan" | "ssh";

export interface RemoteFile {
  name: string;
  size: number;
  type: string;
}

export interface RoomView {
  code: string;
  mode: ShareMode;
  hostName: string;
  publicKey: PublicJwk;
  guestKey: PublicJwk | null;
  fileCount: number;
  totalBytes: number;
  path: "direct" | "relay" | null;
  expiresAt: string;
}

export interface NearbyRoom {
  code: string;
  hostName: string;
  mode: ShareMode;
  fileCount: number;
  totalBytes: number;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : "Request failed.";
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return data;
}

export async function createRoom(input: {
  code: string;
  mode: ShareMode;
  hostName: string;
  publicKey: PublicJwk;
  fileCount: number;
  totalBytes: number;
}): Promise<void> {
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "create", ...input }),
  });
  await readJson(res);
}

export async function fetchRoom(code: string): Promise<RoomView | null> {
  const res = await fetch(`/api/share?code=${code}`);
  if (res.status === 404) return null;
  const data = await readJson(res);
  return data.room as RoomView;
}

export async function publishGuestKey(code: string, publicKey: PublicJwk): Promise<void> {
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "join-key", code, publicKey }),
  });
  await readJson(res);
}

export async function resetGuestKey(code: string): Promise<void> {
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "reset-guest", code }),
  });
  await readJson(res);
}

export async function claimPath(code: string, path: "direct" | "relay"): Promise<"direct" | "relay"> {
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "claim-path", code, path }),
  });
  const data = await readJson(res);
  return data.path === "relay" ? "relay" : "direct";
}

export async function closeRoom(code: string): Promise<void> {
  await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "close", code }),
    keepalive: true,
  }).catch(() => {});
}

export async function fetchNearby(): Promise<NearbyRoom[]> {
  const res = await fetch("/api/share?nearby=1");
  const data = await readJson(res);
  return (data.rooms as NearbyRoom[]) ?? [];
}
