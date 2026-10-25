/**
 * File reception security: filename sanitization and dangerous-type detection.
 *
 * Defends against:
 *  - Unicode BiDi override / isolate characters that disguise extensions
 *  - Control characters, path separators, traversal components
 *  - Reserved Windows platform names (CON, PRN, AUX, NUL, COM1–9, LPT1–9)
 *  - Excessively long names (> 255 chars after sanitization)
 *  - Empty names and names that collapse to only dots/spaces
 *  - Dangerous executable, script, installer, and active-content extensions
 *  - Double-extension camouflage (e.g. invoice.pdf.exe)
 *
 * Never implements custom crypto. Never auto-executes content. Never renders
 * untrusted HTML/SVG. Extension lists are defense-in-depth only; always treat
 * filenames and MIME types from the sender as untrusted.
 */

/** Unicode BiDi override / isolate codepoints that can disguise extensions. */
const BIDI_OVERRIDES = /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200F\u200E\u061C]/g;

/** C0 and C1 control characters (except normal printable range). */
// eslint-disable-next-line no-control-regex -- intentionally matches untrusted control characters
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Path separators and traversal components. */
const PATH_UNSAFE = /[/\\]/g;

/**
 * Reserved names on Windows that must not be used as file names even with an
 * extension (e.g. "NUL.txt" is still a device reference on Windows).
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Extensions that pose a risk of direct execution, scripting, or
 * privilege escalation. Treat as dangerous on all platforms.
 */
const DANGEROUS_EXTENSIONS = new Set([
  // Windows executables / installers
  "exe", "msi", "com", "pif", "scr", "bat", "cmd", "ps1", "psm1", "psd1",
  "vbs", "vbe", "jse", "wsf", "wsh", "msc", "msp", "mst",
  // Registry
  "reg",
  // Shortcuts
  "lnk", "url",
  // Scripts
  "sh", "bash", "zsh", "fish", "py", "pyw", "rb", "pl", "jar", "class",
  // Active web content (can run in local context or bypass CSP when saved and opened)
  "html", "htm", "hta", "xhtml",
  // SVG can embed arbitrary script
  "svg", "svgz",
  // JavaScript (browser / Node)
  "js", "mjs", "cjs", "ts", "jsx", "tsx",
  // Compiled objects that can be side-loaded
  "dll", "so", "dylib",
  // Office macros and templates
  "docm", "xlsm", "pptm", "dotm", "xltm", "potm",
]);

export interface SanitizeResult {
  /** Sanitized filename safe to suggest to the browser's save dialog. */
  safe: string;
  /**
   * Human-readable warning when the file type is potentially dangerous, or
   * null when the file appears benign.
   */
  warning: string | null;
}

/**
 * Extracts the lowercase final extension from a name (after the last dot).
 * Returns an empty string if there is no extension.
 */
function lastExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Detects a double-extension camouflage pattern such as `invoice.pdf.exe`.
 * Returns true when the penultimate extension is a common document type and
 * the final extension is dangerous.
 */
function hasDoubleExtension(name: string): boolean {
  const parts = name.split(".");
  if (parts.length < 3) return false; // need at least two extensions
  const outerExt = parts[parts.length - 1].toLowerCase();
  if (!DANGEROUS_EXTENSIONS.has(outerExt)) return false;
  const innerExt = parts[parts.length - 2].toLowerCase();
  // Inner "trusted" extensions that get used as camouflage
  const innocent = new Set([
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "txt", "csv", "png", "jpg", "jpeg", "gif", "mp4", "mp3", "zip",
  ]);
  return innocent.has(innerExt);
}

/**
 * Sanitize a sender-supplied filename for safe display and save-dialog use.
 *
 * @param name - Raw filename from the sender's file control frame.
 * @returns `{ safe, warning }` — `safe` is always a usable filename string;
 *          `warning` is non-null when the file type is flagged as dangerous.
 */
export function sanitizeFileName(name: string): SanitizeResult {
  if (typeof name !== "string" || name.length === 0) {
    return { safe: "received-file", warning: null };
  }

  // 1. Strip BiDi override / isolate characters, but remember their presence:
  // removal can make a deceptive filename look benign, so it must still warn.
  const hadBidiControls = BIDI_OVERRIDES.test(name);
  BIDI_OVERRIDES.lastIndex = 0;
  let s = name.replace(BIDI_OVERRIDES, "");

  // 2. Strip control characters.
  s = s.replace(CONTROL_CHARS, "");

  // 3. Collapse path separators — keep only the filename component.
  const segments = s.split(PATH_UNSAFE);
  s = segments[segments.length - 1] ?? "";

  // 4. Remove trailing dots and spaces (Windows ignores them, Linux-confusing).
  s = s.replace(/[. ]+$/, "").trim();

  // 5. Collapse multiple consecutive dots into one (hides extensions).
  s = s.replace(/\.{2,}/g, ".");

  // 6. Trim to 255 characters maximum (FS limit on most platforms).
  if (s.length > 255) {
    const ext = lastExt(s);
    const stem = s.slice(0, 255 - (ext ? ext.length + 1 : 0));
    s = ext ? `${stem}.${ext}` : stem;
  }

  // 7. Fallback for names that collapsed to empty or only dots.
  if (!s || s === ".") s = "received-file";

  // 8. Substitute reserved Windows names.
  if (WINDOWS_RESERVED.test(s)) {
    s = `_${s}`;
  }

  // 9. Dangerous extension / double-extension detection.
  const ext = lastExt(s);
  const doubleCamouflage = hasDoubleExtension(s);
  const isDangerous = DANGEROUS_EXTENSIONS.has(ext) || doubleCamouflage;

  let warning: string | null = null;
  if (hadBidiControls) {
    warning = "This filename contained hidden directional formatting characters that can disguise its true extension. The characters were removed; proceed only if you trust the sender.";
  }
  if (isDangerous) {
    if (doubleCamouflage) {
      warning = `This file uses a double extension to disguise its type (.${ext}). It may be an executable or script masquerading as a document. Proceed only if you trust the sender.`;
    } else {
      warning = `This file type (.${ext}) can execute code on your device. Only save it if you fully trust the sender and expected this file.`;
    }
  }

  return { safe: s, warning };
}
