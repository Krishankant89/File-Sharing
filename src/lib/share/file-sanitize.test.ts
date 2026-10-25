import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeFileName } from "./file-sanitize.ts";

test("sanitizes path traversal and control characters", () => {
  assert.equal(sanitizeFileName("../../safe.txt\u0000\n").safe, "safe.txt");
});

test("removes bidi controls and warns about dangerous extensions", () => {
  const result = sanitizeFileName("invoice.pdf\u202Eexe");
  assert.equal(result.safe, "invoice.pdfexe");
  assert.ok(result.warning?.includes("directional formatting"));
});

test("warns for dangerous extensions and double extensions", () => {
  assert.ok(sanitizeFileName("setup.exe").warning);
  assert.ok(sanitizeFileName("invoice.pdf.exe").warning?.includes("double extension"));
});

test("replaces reserved names and empty names", () => {
  assert.equal(sanitizeFileName("NUL.txt").safe, "_NUL.txt");
  assert.equal(sanitizeFileName("../../").safe, "received-file");
});

test("preserves normal filenames", () => {
  assert.equal(sanitizeFileName("family-photo 2026.jpg").safe, "family-photo 2026.jpg");
  assert.equal(sanitizeFileName("family-photo 2026.jpg").warning, null);
});
