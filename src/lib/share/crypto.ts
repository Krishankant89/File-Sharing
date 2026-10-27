export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

export async function generateRoomKeys(): Promise<{ publicJwk: PublicJwk; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!exported.x || !exported.y) throw new Error("Could not create a session key.");
  return {
    publicJwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y },
    privateKey: pair.privateKey,
  };
}

async function importPublic(jwk: PublicJwk, extractable: boolean) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    [],
  );
}

export async function fingerprintForJwk(jwk: PublicJwk): Promise<string> {
  const pub = await importPublic(jwk, true);
  const spki = await crypto.subtle.exportKey("spki", pub);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `SHA256:${btoa(binary).replace(/=+$/g, "")}`;
}

export async function deriveSessionKey(
  privateKey: CryptoKey,
  theirPublic: PublicJwk,
  code: string,
): Promise<CryptoKey> {
  const pub = await importPublic(theirPublic, false);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`peakline-${code}`),
      info: new TextEncoder().encode("peakline-ssh-aes-256-gcm-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key: CryptoKey, plain: Uint8Array, seq: number): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new Uint8Array(4);
  new DataView(ad.buffer).setUint32(0, seq);
  const data = new Uint8Array(plain.byteLength);
  data.set(plain);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, data),
  );
  const out = new Uint8Array(16 + cipher.length);
  new DataView(out.buffer).setUint32(0, seq);
  out.set(iv, 4);
  out.set(cipher, 16);
  return out;
}

export async function openSeal(key: CryptoKey, packet: Uint8Array): Promise<{ seq: number; plain: Uint8Array }> {
  if (packet.length < 16 + 16) throw new Error("Encrypted packet is too short.");
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const seq = view.getUint32(0);
  const iv = new Uint8Array(12);
  iv.set(packet.subarray(4, 16));
  const cipher = new Uint8Array(packet.length - 16);
  cipher.set(packet.subarray(16));
  const ad = new Uint8Array(4);
  new DataView(ad.buffer).setUint32(0, seq);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, key, cipher),
  );
  return { seq, plain };
}
