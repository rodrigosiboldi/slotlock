const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromB64url = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

/**
 * Keys derived from APP_SECRET with HKDF, one per purpose, so a single secret in the
 * environment never doubles as both an encryption key and a signing key.
 */
export interface Secrets {
  /** AES-256-GCM. Output: `v1.<iv>.<ciphertext+tag>`, base64url. */
  encrypt(plaintext: string): Promise<string>;
  decrypt(sealed: string): Promise<string>;
  /** HMAC-SHA256 token: `<payload>.<signature>`; the payload must not contain dots. */
  sign(payload: string): Promise<string>;
  /** The payload when the signature is valid, otherwise null. */
  verify(token: string): Promise<string | null>;
}

export async function createSecrets(appSecret: string): Promise<Secrets> {
  const master = await crypto.subtle.importKey("raw", encoder.encode(appSecret), "HKDF", false, ["deriveKey"]);
  type DeriveParams = Parameters<typeof crypto.subtle.deriveKey>;
  const derive = (info: string, algorithm: DeriveParams[2], usages: DeriveParams[4]) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode("slotlock"), info: encoder.encode(info) },
      master,
      algorithm,
      false,
      usages,
    );
  const aesKey = await derive("slotlock/webhook-secrets/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
  const hmacKey = await derive("slotlock/tokens/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, [
    "sign",
    "verify",
  ]);

  return {
    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoder.encode(plaintext));
      return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
    },
    async decrypt(sealed) {
      const [version, iv, ciphertext] = sealed.split(".");
      if (version !== "v1" || !iv || !ciphertext) throw new Error("Unsupported ciphertext format");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64url(iv) },
        aesKey,
        fromB64url(ciphertext),
      );
      return decoder.decode(plaintext);
    },
    async sign(payload) {
      if (payload.includes(".")) throw new Error("Token payloads cannot contain dots");
      const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(payload));
      return `${payload}.${b64url(new Uint8Array(signature))}`;
    },
    async verify(token) {
      const dot = token.lastIndexOf(".");
      if (dot <= 0) return null;
      const payload = token.slice(0, dot);
      const signature = fromB64url(token.slice(dot + 1));
      const valid = await crypto.subtle.verify("HMAC", hmacKey, signature, encoder.encode(payload));
      return valid ? payload : null;
    },
  };
}
