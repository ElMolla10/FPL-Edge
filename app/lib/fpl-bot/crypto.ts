/**
 * AES-GCM (WebCrypto) for the bot's tokens at rest in D1, keyed by the Worker secret FPL_EDGE_BOT_TOKEN_KEY
 * (base64 of 32 random bytes: `openssl rand -base64 32`). Format: "v1." + base64(iv) + "." + base64(ciphertext).
 * Without a valid key the bot refuses to store tokens at all (never falls back to plaintext).
 */

const VERSION = "v1";

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class BotKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotKeyError";
  }
}

export async function importBotKey(raw: string | null | undefined): Promise<CryptoKey> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new BotKeyError("FPL_EDGE_BOT_TOKEN_KEY is not set");
  let bytes: Uint8Array;
  try {
    bytes = b64decode(trimmed);
  } catch {
    throw new BotKeyError("FPL_EDGE_BOT_TOKEN_KEY is not valid base64");
  }
  if (bytes.length !== 32) throw new BotKeyError("FPL_EDGE_BOT_TOKEN_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return `${VERSION}.${b64encode(iv)}.${b64encode(cipher)}`;
}

export async function decryptToken(key: CryptoKey, sealed: string): Promise<string> {
  const [version, ivPart, cipherPart] = sealed.split(".");
  if (version !== VERSION || !ivPart || !cipherPart) throw new BotKeyError("unsupported token envelope");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivPart) as BufferSource }, key, b64decode(cipherPart) as BufferSource);
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Strip anything token-shaped from text that may reach logs / D1 error columns / API responses. */
export function redact(text: string, max = 300): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, "[jwt]")
    .replace(/("?(refresh_token|access_token|id_token|authorization)"?\s*[:=]\s*)"?[^"\s,}]+"?/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, max);
}
