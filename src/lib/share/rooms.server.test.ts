import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import {
  clientAddressFromTrustedProxy,
  readBoundedJson,
  RequestSizeError,
} from "./request-security.server.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const sourcePath = new URL(`../../${specifier.slice(2)}.ts`, import.meta.url);
      return nextResolve(sourcePath.href, context);
    }
    return nextResolve(specifier, context);
  },
});

type LimitResult = { ok: boolean; retryAfter?: number };

const room = {
  code: "1234567890",
  mode: "remote",
  host_name: "Peakline",
  public_key: { kty: "EC", crv: "P-256", x: "abcdefgh", y: "abcdefgh" },
  guest_key: null,
  file_count: 1,
  total_bytes: 0,
  path: null,
  expires_at: "2030-01-01T00:00:00.000Z",
};
type TestRoom = Omit<typeof room, "guest_key"> & { guest_key: typeof room.public_key | null };

let limiter: (clientId: string) => Promise<LimitResult> = async () => ({ ok: true });
let limiterCalls: string[] = [];
let roomRow: TestRoom | null = room;
let insertedRoom = true;

mock.module("@/lib/db", {
  namedExports: {
    getSql: async () => ({
      query: async (query: string, params: unknown[] = []) => {
        if (query.includes("SELECT code, mode, host_name")) {
          return roomRow && roomRow.code === params[0] ? [roomRow] : [];
        }
        if (query.includes("SELECT code FROM share_rooms WHERE expires_at")) return [];
        if (query.includes("INSERT INTO share_rooms")) {
          return insertedRoom
            ? [{ code: "1234567890", expires_at: "2030-01-01T00:00:00.000Z" }]
            : [];
        }
        return [];
      },
    }),
  },
});

mock.module("@/lib/share/format", {
  namedExports: { MAX_BYTES: 10 * 1024 * 1024 * 1024, MAX_FILES: 40, RELAY_CAP_BYTES: 25 * 1024 * 1024 },
});

mock.module("@/lib/share/request-security.server", {
  namedExports: { clientAddressFromTrustedProxy, readBoundedJson, RequestSizeError },
});

mock.module("@/lib/share/rate-limit.server", {
  namedExports: {
    limitShareRequests: async (clientId: string) => {
      limiterCalls.push(clientId);
      return limiter(clientId);
    },
  },
});

const { handleShare } = await import("./rooms.server.ts");

function reset(options: { limiter?: typeof limiter; row?: TestRoom | null; inserted?: boolean } = {}) {
  limiter = options.limiter ?? (async () => ({ ok: true }));
  limiterCalls = [];
  roomRow = options.row === undefined ? room : options.row;
  insertedRoom = options.inserted ?? true;
}

function clientRequest(url: string, init: RequestInit = {}, address = "192.0.2.10") {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", `${address}, 10.0.0.1`);
  return new Request(`https://peakline.test${url}`, { ...init, headers });
}

function createRequest() {
  return clientRequest(
    "/api/share",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "create",
        code: "1234567890",
        mode: "remote",
        hostName: "Peakline",
        publicKey: room.public_key,
        fileCount: 1,
        totalBytes: 0,
      }),
    },
    "192.0.2.20",
  );
}

process.env.TRUST_PROXY_HEADERS = "true";
process.env.TRUSTED_PROXY_HOPS = "1";

test("allowed GET lookup proceeds and uses the trusted client identity", async () => {
  reset();

  const response = await handleShare(clientRequest("/api/share?code=1234567890"));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).room.code, "1234567890");
  assert.deepEqual(limiterCalls, ["192.0.2.10"]);
});

test("GET lookup returns 429 and Retry-After when Redis denies it", async () => {
  reset({ limiter: async () => ({ ok: false, retryAfter: 30 }) });

  const response = await handleShare(clientRequest("/api/share?code=1234567890"));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("GET lookup omits Retry-After when Redis provides no retry time", async () => {
  reset({ limiter: async () => ({ ok: false }) });

  const response = await handleShare(clientRequest("/api/share?code=1234567890"));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
});

test("GET lookup returns a generic 503 when Redis throws", async () => {
  reset({ limiter: async () => { throw new Error("redis secret and stack detail"); } });

  const response = await handleShare(clientRequest("/api/share?code=1234567890"));
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /temporarily unavailable/i);
  assert.doesNotMatch(body, /redis secret|stack detail/i);
});

test("allowed room creation proceeds through the create endpoint", async () => {
  reset();

  const response = await handleShare(createRequest());

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(limiterCalls, ["192.0.2.20"]);
});

test("room creation returns 429 and Retry-After when Redis denies it", async () => {
  reset({ limiter: async () => ({ ok: false, retryAfter: 30 }) });

  const response = await handleShare(createRequest());

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("room creation returns a generic 503 when Redis throws", async () => {
  reset({ limiter: async () => { throw new Error("private redis endpoint token"); } });

  const response = await handleShare(createRequest());
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /temporarily unavailable/i);
  assert.doesNotMatch(body, /private redis endpoint token/i);
});

test("unrelated POST operations keep their existing behavior without a Redis check", async () => {
  reset({ row: { ...room, guest_key: room.public_key } });
  const request = clientRequest(
    "/api/share",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "join-key", code: room.code, publicKey: room.public_key }),
    },
    "192.0.2.30",
  );

  const response = await handleShare(request);

  assert.equal(response.status, 409);
  assert.equal(limiterCalls.length, 0);
});

test("eight failed lookups retain the five-minute in-memory passcode lockout", async () => {
  reset({ row: null });
  const request = () => clientRequest("/api/share?code=0000000000", {}, "192.0.2.40");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal((await handleShare(request())).status, 404);
  }
  const locked = await handleShare(request());
  const body = await locked.json();

  assert.equal(locked.status, 429);
  assert.match(body.error, /wait 300s/i);
  assert.equal(limiterCalls.length, 8);
});