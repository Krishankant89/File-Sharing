import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedJson, RequestSizeError } from "./request-security.server.ts";

test("reads valid bounded JSON", async () => {
  const request = new Request("https://example.test", { method: "POST", body: JSON.stringify({ ok: true }) });
  assert.deepEqual(await readBoundedJson(request, 100), { ok: true });
});

test("rejects declared oversized request bodies", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": "1000" },
    body: "{}",
  });
  await assert.rejects(readBoundedJson(request, 10), RequestSizeError);
});

test("rejects streamed bodies that exceed the limit", async () => {
  const request = new Request("https://example.test", { method: "POST", body: JSON.stringify({ payload: "x".repeat(50) }) });
  await assert.rejects(readBoundedJson(request, 10), RequestSizeError);
});
