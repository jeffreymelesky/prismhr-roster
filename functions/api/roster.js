// Cloudflare Pages Function: GET /api/roster
// Reads the roster from Supabase using a server-side secret key.
// Fails closed: every request must carry a valid Cloudflare Access token,
// so the *.pages.dev address can't be used to bypass the email login.
//
// Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY   (secret) service_role or sb_secret_ key
//   ACCESS_TEAM_DOMAIN    e.g. emplova.cloudflareaccess.com
//   ACCESS_AUD            Application Audience (AUD) tag from the Access application
//   CLIENT_ID, CLIENT_NAME  (optional) label shown on the page

export async function onRequestGet({ request, env }) {
  try {
    await verifyAccess(request, env);
  } catch (e) {
    return json({ error: "Not authorized" }, 403);
  }

  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const base = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";

  const [empRes, runRes] = await Promise.all([
    fetch(base + "prism_employees?select=employee_id,first_name,last_name,job_title,status,hire_date,synced_at&order=last_name.asc,first_name.asc", { headers }),
    fetch(base + "prism_sync_runs?select=finished_at,ok,employee_count,message&finished_at=not.is.null&order=id.desc&limit=1", { headers }),
  ]);
  if (!empRes.ok) return json({ error: "Database error " + empRes.status }, 502);

  const employees = await empRes.json();
  const runs = runRes.ok ? await runRes.json() : [];
  return json({ client: { id: env.CLIENT_ID || "", name: env.CLIENT_NAME || "Roster" }, employees, lastSync: runs[0] || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---- Cloudflare Access JWT verification (RS256) ----
let certCache = { at: 0, keys: [] };

async function verifyAccess(request, env) {
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
