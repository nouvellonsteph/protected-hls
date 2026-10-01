const encoder = new TextEncoder();

export type TokenClaims = {
  st: number;
  exp: number;
  acl: string;
  id?: string;
  ip?: string;
};

export class TokenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const fields = [
    `st=${claims.st}`,
    `exp=${claims.exp}`,
    `acl=${claims.acl}`,
  ];
  if (claims.id) fields.push(`id=${claims.id}`);
  if (claims.ip) fields.push(`ip=${claims.ip}`);
  const unsigned = fields.join("~");
  return `${unsigned}~hmac=${await hmacHex(unsigned, secret)}`;
}

function parseToken(token: string): { claims: TokenClaims; unsigned: string; signature: string } {
  if (!token || token.length > 2048) {
    throw new TokenError("malformed", "Token is missing or too large");
  }

  const parts = token.split("~");
  if (parts.length < 4 || !parts.at(-1)?.startsWith("hmac=")) {
    throw new TokenError("malformed", "Token signature must be the final field");
  }

  const values = new Map<string, string>();
  const allowed = new Set(["st", "exp", "acl", "id", "ip", "hmac"]);
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 1) throw new TokenError("malformed", "Token field is invalid");
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!allowed.has(key) || values.has(key) || !value) {
      throw new TokenError("malformed", "Token contains an invalid or duplicate field");
    }
    values.set(key, value);
  }

  const stValue = values.get("st");
  const expValue = values.get("exp");
  const acl = values.get("acl");
  const signature = values.get("hmac");
  if (!stValue || !expValue || !acl || !signature || !/^\d+$/.test(stValue) || !/^\d+$/.test(expValue)) {
    throw new TokenError("malformed", "Token is missing required fields");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw new TokenError("malformed", "Token signature is invalid");
  }

  return {
    claims: {
      st: Number(stValue),
      exp: Number(expValue),
      acl,
      id: values.get("id"),
      ip: values.get("ip"),
    },
    unsigned: parts.slice(0, -1).join("~"),
    signature: signature.toLowerCase(),
  };
}

export function aclAllows(acl: string, path: string): boolean {
  return acl.split("!").some((pattern) => {
    const wildcard = pattern.endsWith("*");
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    return wildcard ? path.startsWith(prefix) : path === prefix;
  });
}

export async function verifyToken(
  token: string,
  secrets: Array<string | undefined>,
  options: {
    path: string;
    ip?: string;
    now?: number;
    clockSkewSeconds?: number;
    maxLifetimeSeconds: number;
  },
): Promise<TokenClaims & { keyIndex: number }> {
  const parsed = parseToken(token);
  let keyIndex = -1;
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    if (!secret) continue;
    const expected = await hmacHex(parsed.unsigned, secret);
    if (constantTimeEqual(expected, parsed.signature)) {
      keyIndex = index;
      break;
    }
  }
  if (keyIndex < 0) throw new TokenError("signature", "Token signature does not match");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  if (parsed.claims.st > now + skew) throw new TokenError("not_started", "Token is not active yet");
  if (parsed.claims.exp < now - skew) throw new TokenError("expired", "Token has expired");
  if (parsed.claims.exp <= parsed.claims.st || parsed.claims.exp - parsed.claims.st > options.maxLifetimeSeconds) {
    throw new TokenError("lifetime", "Token lifetime exceeds policy");
  }
  if (!aclAllows(parsed.claims.acl, options.path)) {
    throw new TokenError("acl", "Token does not allow this path");
  }
  if (parsed.claims.ip && parsed.claims.ip !== options.ip) {
    throw new TokenError("ip", "Token is bound to another client IP");
  }

  return { ...parsed.claims, keyIndex };
}
