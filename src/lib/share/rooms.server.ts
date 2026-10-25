import { createHash } from "node:crypto";
import { z } from "zod";
import { getSql, type Sql } from "@/lib/db";
import { MAX_BYTES, MAX_FILES, RELAY_CAP_BYTES } from "@/lib/share/format";
import { clientAddressFromTrustedProxy, readBoundedJson, RequestSizeError } from "@/lib/share/request-security.server";

const CODE = z.string().regex(/^\d{10}$/);
const modeSchema = z.enum(["remote", "lan", "ssh"]);
const jwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(8).max(128),
  y: z.string().min(8).max(128),
});
const fileSchema = z.object({
  name: z.string().min(1).max(180),
  size: z.number().int().nonnegative().max(MAX_BYTES),
  type: z.string().max(120),
});

const globalRef = globalThis as typeof globalThis & {
  __shareSchemaPromise__?: Promise<void>;
};

// Rate limiter tracking lookups and failures per IP
interface RateLimitEntry {
  count: number;
  failures: number;
  resetAt: number;
  blockedUntil: number;
}
const ipLimits = new Map<string, RateLimitEntry>();
let limiterOperations = 0;
const MAX_RATE_LIMIT_KEYS = 10_000;

function pruneRateLimitEntries(now: number) {
  // Bound memory use when clients rotate spoofed identities or generate many IPs.
  for (const [key, entry] of ipLimits) {
    if (entry.resetAt < now && entry.blockedUntil <= now) ipLimits.delete(key);
  }
  while (ipLimits.size > MAX_RATE_LIMIT_KEYS) {
    const oldest = ipLimits.keys().next().value;
    if (oldest === undefined) break;
    ipLimits.delete(oldest);
  }
}

function checkRateLimit(ip: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  limiterOperations += 1;
  if (limiterOperations % 128 === 0 || ipLimits.size >= MAX_RATE_LIMIT_KEYS) pruneRateLimitEntries(now);
  let entry = ipLimits.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, failures: 0, resetAt: now + 60_000, blockedUntil: 0 };
    ipLimits.set(ip, entry);
  }
  if (entry.blockedUntil > now) {
    const waitSec = Math.ceil((entry.blockedUntil - now) / 1000);
    return { ok: false, reason: `Too many failed passcode attempts. Please wait ${waitSec}s.` };
  }
  entry.count += 1;
  if (entry.count > 150) {
    return { ok: false, reason: "Too many requests. Please slow down." };
  }
  return { ok: true };
}

function recordFailure(ip: string) {
  const now = Date.now();
  let entry = ipLimits.get(ip);
  if (!entry) {
    entry = { count: 1, failures: 1, resetAt: now + 60_000, blockedUntil: 0 };
    ipLimits.set(ip, entry);
  } else {
    entry.failures += 1;
  }
  if (entry.failures >= 8) {
    entry.blockedUntil = now + 5 * 60_000; // 5 minute lock on brute-forcing codes
  }
}

function recordSuccess(ip: string) {
  const entry = ipLimits.get(ip);
  if (entry && entry.failures > 0) {
    entry.failures = Math.max(0, entry.failures - 1);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function checkProductionDatabase(): Response | null {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.DATABASE_URL &&
    (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  ) {
    return json(
      {
        error:
          "DATABASE_URL must be configured in production for signaling across serverless instances. Set DATABASE_URL in environment settings.",
      },
      503,
    );
  }
  return null;
}

function ensureSchema(sql: Sql): Promise<void> {
  globalRef.__shareSchemaPromise__ ??= (async () => {
    await sql.query(
      `CREATE TABLE IF NOT EXISTS share_rooms (
         code TEXT PRIMARY KEY,
         mode TEXT NOT NULL,
         host_name TEXT NOT NULL,
         public_key JSONB NOT NULL,
         guest_key JSONB,
         file_count INTEGER NOT NULL DEFAULT 1,
         total_bytes BIGINT NOT NULL DEFAULT 0,
         files JSONB,
         discoverable BOOLEAN NOT NULL DEFAULT FALSE,
         ip_hash TEXT NOT NULL DEFAULT '',
         path TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at TIMESTAMPTZ NOT NULL
       )`,
    );
    await sql.query(`ALTER TABLE share_rooms ADD COLUMN IF NOT EXISTS file_count INTEGER NOT NULL DEFAULT 1`).catch(() => {});
    await sql.query(`ALTER TABLE share_rooms ADD COLUMN IF NOT EXISTS total_bytes BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await sql.query(`ALTER TABLE share_rooms ALTER COLUMN files DROP NOT NULL`).catch(() => {});
    await sql.query(
      `CREATE TABLE IF NOT EXISTS share_relay (
         id BIGSERIAL PRIMARY KEY,
         code TEXT NOT NULL,
         to_role TEXT NOT NULL,
         body TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await sql.query(
      `CREATE INDEX IF NOT EXISTS share_relay_inbox ON share_relay (code, to_role, id)`,
    );
  })().catch((err) => {
    globalRef.__shareSchemaPromise__ = undefined;
    throw err;
  });
  return globalRef.__shareSchemaPromise__;
}

function clientAddress(request: Request): string {
  return clientAddressFromTrustedProxy(request);
}

function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "local" || ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true;
  return false;
}

function ipHash(request: Request): string {
  return createHash("sha256").update(`peakline-lan|${clientAddress(request)}`).digest("hex").slice(0, 32);
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function stamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

async function pruneExpired(sql: Sql) {
  const expired = await sql.query<{ code: string }>(`SELECT code FROM share_rooms WHERE expires_at < now()`);
  for (const row of expired) {
    await sql.query(`DELETE FROM share_relay WHERE code = $1`, [row.code]);
  }
  await sql.query(`DELETE FROM share_rooms WHERE expires_at < now()`);
  await sql.query(`DELETE FROM share_relay WHERE created_at < now() - interval '15 minutes'`);
}

type RoomRow = {
  code: string;
  mode: "remote" | "lan" | "ssh";
  host_name: string;
  public_key: unknown;
  guest_key: unknown;
  file_count?: number;
  total_bytes?: number;
  path: string | null;
  expires_at: unknown;
};

// Return safe room metadata: do NOT leak filenames, types, or individual files to unauthenticated users
function present(row: RoomRow) {
  return {
    code: row.code,
    mode: row.mode,
    hostName: row.host_name,
    publicKey: asJson(row.public_key),
    guestKey: row.guest_key == null ? null : asJson(row.guest_key),
    fileCount: Number(row.file_count || 1),
    totalBytes: Number(row.total_bytes || 0),
    path: row.path,
    expiresAt: stamp(row.expires_at),
  };
}

async function loadRoom(sql: Sql, code: string): Promise<RoomRow | null> {
  const rows = await sql.query<RoomRow>(
    `SELECT code, mode, host_name, public_key, guest_key, file_count, total_bytes, path, expires_at
     FROM share_rooms WHERE code = $1 AND expires_at > now()`,
    [code],
  );
  return rows[0] ?? null;
}

async function handleGet(request: Request): Promise<Response> {
  const prodErr = checkProductionDatabase();
  if (prodErr) return prodErr;

  const clientIp = clientAddress(request);
  const rate = checkRateLimit(clientIp);
  if (!rate.ok) return json({ error: rate.reason }, 429);

  const url = new URL(request.url);
  const sql = await getSql();
  await ensureSchema(sql);

  if (url.searchParams.get("nearby") === "1") {
    // Only return nearby rooms if the client is genuine local/private IP (RFC1918 or loopback)
    // Avoid grouping strangers behind a shared proxy or CDN IP
    if (!isPrivateIp(clientIp)) {
      return json({ rooms: [] });
    }

    const rows = await sql.query<{
      code: string;
      host_name: string;
      mode: string;
      file_count: number;
      total_bytes: number;
    }>(
      `SELECT code, host_name, mode, file_count, total_bytes FROM share_rooms
       WHERE discoverable = TRUE AND ip_hash = $1 AND guest_key IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 8`,
      [ipHash(request)],
    );
    return json({
      rooms: rows.map((row) => ({
        code: row.code,
        hostName: row.host_name,
        mode: row.mode,
        fileCount: Number(row.file_count || 1),
        totalBytes: Number(row.total_bytes || 0),
      })),
    });
  }

  const code = CODE.safeParse(url.searchParams.get("code"));
  if (!code.success) return json({ error: "Enter the 10-digit passcode." }, 400);

  const row = await loadRoom(sql, code.data);
  if (!row) {
    recordFailure(clientIp);
    return json({ error: "That passcode isn't active." }, 404);
  }

  recordSuccess(clientIp);
  return json({ room: present(row) });
}

async function handlePost(request: Request): Promise<Response> {
  const prodErr = checkProductionDatabase();
  if (prodErr) return prodErr;

  const clientIp = clientAddress(request);
  const rate = checkRateLimit(clientIp);
  if (!rate.ok) return json({ error: rate.reason }, 429);

  let body: unknown;
  try {
    body = await readBoundedJson(request, 256 * 1024);
  } catch (error) {
    if (error instanceof RequestSizeError) return json({ error: "Request body too large." }, 413);
    return json({ error: "invalid JSON" }, 400);
  }
  const sql = await getSql();
  await ensureSchema(sql);
  const op = z.object({ op: z.string() }).safeParse(body);
  if (!op.success) return json({ error: "invalid request" }, 400);

  if (op.data.op === "create") {
    const parsed = z
      .object({
        op: z.literal("create"),
        code: CODE,
        mode: modeSchema,
        hostName: z.string().trim().min(1).max(32),
        publicKey: jwkSchema,
        fileCount: z.number().int().min(1).max(MAX_FILES).optional(),
        totalBytes: z.number().int().nonnegative().max(MAX_BYTES).optional(),
        files: z.array(fileSchema).max(MAX_FILES).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return json({ error: "Check the transfer details and try again." }, 400);

    const count = parsed.data.files?.length || parsed.data.fileCount || 1;
    const total = parsed.data.files?.reduce((sum, f) => sum + f.size, 0) ?? parsed.data.totalBytes ?? 0;
    if (total > MAX_BYTES) return json({ error: "Peakline sends up to 10 GB at a time." }, 400);

    await pruneExpired(sql);

    // Only enable LAN discovery when the request originates from a genuine private IP
    const isLocal = isPrivateIp(clientIp);
    const discoverable = parsed.data.mode === "lan" && isLocal;

    // Do NOT store plaintext filenames or MIME types in the database
    const inserted = await sql.query<{ code: string; expires_at: unknown }>(
      `INSERT INTO share_rooms (code, mode, host_name, public_key, file_count, total_bytes, files, discoverable, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, '[]'::jsonb, $7, $8, now() + interval '2 hours')
       ON CONFLICT (code) DO NOTHING
       RETURNING code, expires_at`,
      [
        parsed.data.code,
        parsed.data.mode,
        parsed.data.hostName,
        JSON.stringify(parsed.data.publicKey),
        count,
        total,
        discoverable,
        ipHash(request),
      ],
    );
    if (!inserted[0]) return json({ error: "That passcode was just taken. Try again." }, 409);
    return json({ ok: true, expiresAt: stamp(inserted[0].expires_at) });
  }

  if (op.data.op === "join-key") {
    const parsed = z.object({ op: z.literal("join-key"), code: CODE, publicKey: jwkSchema }).safeParse(body);
    if (!parsed.success) return json({ error: "Enter the 10-digit passcode." }, 400);
    const room = await loadRoom(sql, parsed.data.code);
    if (!room) {
      recordFailure(clientIp);
      return json({ error: "That passcode isn't active." }, 404);
    }
    if (room.guest_key != null) return json({ error: "Someone already joined this passcode." }, 409);
    const updated = await sql.query<{ code: string }>(
      `UPDATE share_rooms SET guest_key = $2::jsonb
       WHERE code = $1 AND guest_key IS NULL AND expires_at > now()
       RETURNING code`,
      [parsed.data.code, JSON.stringify(parsed.data.publicKey)],
    );
    if (!updated[0]) return json({ error: "Someone already joined this passcode." }, 409);
    return json({ ok: true });
  }

  if (op.data.op === "reset-guest") {
    // Allows reconnecting or retrying after a clean reload or connection drop
    const parsed = z.object({ op: z.literal("reset-guest"), code: CODE }).safeParse(body);
    if (!parsed.success) return json({ error: "Enter the 10-digit passcode." }, 400);
    await sql.query(
      `UPDATE share_rooms SET guest_key = NULL, path = NULL WHERE code = $1 AND expires_at > now()`,
      [parsed.data.code],
    );
    await sql.query(`DELETE FROM share_relay WHERE code = $1`, [parsed.data.code]);
    return json({ ok: true });
  }

  if (op.data.op === "claim-path") {
    const parsed = z
      .object({ op: z.literal("claim-path"), code: CODE, path: z.enum(["direct", "relay"]) })
      .safeParse(body);
    if (!parsed.success) return json({ error: "invalid request" }, 400);
    const updated = await sql.query<{ path: string }>(
      `UPDATE share_rooms SET path = $2
       WHERE code = $1 AND expires_at > now() AND (path IS NULL OR path = $2)
       RETURNING path`,
      [parsed.data.code, parsed.data.path],
    );
    if (updated[0]?.path === "direct" || updated[0]?.path === "relay") {
      return json({ path: updated[0].path });
    }
    const room = await loadRoom(sql, parsed.data.code);
    if (!room?.path) return json({ error: "That passcode isn't active." }, 404);
    return json({ path: room.path });
  }

  if (op.data.op === "relay-put") {
    const parsed = z
      .object({
        op: z.literal("relay-put"),
        code: CODE,
        to: z.enum(["host", "guest"]),
        body: z.string().min(1).max(120_000),
      })
      .safeParse(body);
    if (!parsed.success) return json({ error: "Packet was rejected." }, 400);
    const room = await loadRoom(sql, parsed.data.code);
    if (!room) return json({ error: "That passcode isn't active." }, 404);

    // Reject bulk files on the encrypted relay mailbox
    if (Number(room.total_bytes || 0) > RELAY_CAP_BYTES) {
      return json(
        { error: "Encrypted relay is limited to 25 MB. Use direct connection for larger transfers." },
        413,
      );
    }

    const countRows = await sql.query<{ n: number }>(
      `SELECT count(*) AS n FROM share_relay WHERE code = $1`,
      [parsed.data.code],
    );
    if (Number(countRows[0]?.n ?? 0) >= 16) return json({ error: "busy" }, 429);
    await sql.query(`INSERT INTO share_relay (code, to_role, body) VALUES ($1, $2, $3)`, [
      parsed.data.code,
      parsed.data.to,
      parsed.data.body,
    ]);
    return json({ ok: true });
  }

  if (op.data.op === "relay-take") {
    const parsed = z
      .object({ op: z.literal("relay-take"), code: CODE, role: z.enum(["host", "guest"]) })
      .safeParse(body);
    if (!parsed.success) return json({ error: "invalid request" }, 400);
    const rows = await sql.query<{ id: number; body: string }>(
      `SELECT id, body FROM share_relay WHERE code = $1 AND to_role = $2 ORDER BY id LIMIT 8`,
      [parsed.data.code, parsed.data.role],
    );
    if (rows.length) {
      const ids = rows.map((row) => Number(row.id));
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
      await sql.query(`DELETE FROM share_relay WHERE id IN (${placeholders})`, ids);
    }
    return json({ messages: rows.map((row) => ({ id: Number(row.id), body: row.body })) });
  }

  if (op.data.op === "close") {
    const parsed = z.object({ op: z.literal("close"), code: CODE }).safeParse(body);
    if (!parsed.success) return json({ error: "invalid request" }, 400);
    await sql.query(`DELETE FROM share_relay WHERE code = $1`, [parsed.data.code]);
    await sql.query(`DELETE FROM share_rooms WHERE code = $1`, [parsed.data.code]);
    return json({ ok: true });
  }

  return json({ error: "invalid request" }, 400);
}

export async function handleShare(request: Request): Promise<Response> {
  try {
    if (request.method === "GET") return await handleGet(request);
    if (request.method === "POST") return await handlePost(request);
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("[share]", error);
    return json({ error: "The transfer service couldn't complete that." }, 500);
  }
}
