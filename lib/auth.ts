/**
 * Validates the Authorization header against the MCP_BEARER_TOKEN env.
 * claude.ai sends `Authorization: Bearer <secret>` on every request.
 */

export function checkAuth(req: Request): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || expected.length < 16) {
    return { ok: false, reason: "Server misconfigured: MCP_BEARER_TOKEN missing or too short" };
  }
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, reason: "Missing or malformed Authorization header" };
  const provided = m[1].trim();
  // Constant-time compare to avoid timing side channels.
  if (provided.length !== expected.length) return { ok: false, reason: "Invalid token" };
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "Invalid token" };
}
