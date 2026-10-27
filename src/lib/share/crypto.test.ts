import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSessionKey,
  fingerprintForJwk,
  generateRoomKeys,
  openSeal,
  seal,
} from "./crypto.ts";

const code = "1234567890";

test("room keys keep the private key non-extractable and export the public JWK", async () => {
  const keys = await generateRoomKeys();

  assert.equal(keys.privateKey.extractable, false);
  assert.deepEqual(
    Object.keys(keys.publicJwk).sort(),
    ["crv", "kty", "x", "y"],
  );
  assert.equal(keys.publicJwk.kty, "EC");
  assert.equal(keys.publicJwk.crv, "P-256");
  assert.ok(keys.publicJwk.x.length > 0);
  assert.ok(keys.publicJwk.y.length > 0);
  assert.match(await fingerprintForJwk(keys.publicJwk), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("peers derive matching session keys and exchange AES-GCM packets", async () => {
  const host = await generateRoomKeys();
  const guest = await generateRoomKeys();
  const hostKey = await deriveSessionKey(host.privateKey, guest.publicJwk, code);
  const guestKey = await deriveSessionKey(guest.privateKey, host.publicJwk, code);
  const plaintext = new TextEncoder().encode("Peakline encrypted payload");
  const packet = await seal(hostKey, plaintext, 4);

  const opened = await openSeal(guestKey, packet);

  assert.equal(opened.seq, 4);
  assert.deepEqual(opened.plain, plaintext);
});

test("AES-GCM rejects modified ciphertext", async () => {
  const host = await generateRoomKeys();
  const guest = await generateRoomKeys();
  const hostKey = await deriveSessionKey(host.privateKey, guest.publicJwk, code);
  const guestKey = await deriveSessionKey(guest.privateKey, host.publicJwk, code);
  const packet = await seal(hostKey, new TextEncoder().encode("authenticated payload"), 0);
  packet[packet.length - 1] ^= 1;

  await assert.rejects(openSeal(guestKey, packet));
});