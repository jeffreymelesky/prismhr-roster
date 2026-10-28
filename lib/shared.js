// Shared helpers for the Pages Functions (not a route itself; lives outside /functions).

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function supabase(env) {
  const key = (env.SUPABASE_SECRET_KEY || "").trim();
  if (!key || !env.SUPABASE_URL) throw new Error("Supabase not configured");
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const base = env.SUPABASE_URL.trim().replace(/\/$/, "") + "/rest/v1/";
  return (path, init = {}) => fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

// ---- Cloudflare Access JWT verification (RS256). Throws if the request isn't from a logged-in user. ----
let certCache = { at: 0, keys: [] };

export async function verifyAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error("Access not configured");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("No token");
  const [h64, p64, s64] = token.split(".");
  const header = JSON.parse(b64urlText(h64));
  const payload = JSON.parse(b64urlText(p64));

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) throw new Error("Bad audience");
  if (payload.exp && payload.exp < now) throw new Error("Expired");
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Error("Bad issuer");

  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.length) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
  if (!valid) throw new Error("Bad signature");
  return payload;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}
