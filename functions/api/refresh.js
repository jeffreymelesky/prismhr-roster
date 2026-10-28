// Cloudflare Pages Function: POST /api/refresh
// Records a "refresh now" request in Supabase. The sync server checks for pending
// requests every minute, so the website never needs to reach the server or PrismHR.
// Guards: Access login required, same-origin only, and at most one request per minute.

import { json, supabase, verifyAccess } from "../../lib/shared.js";

const COOLDOWN_MS = 60_000;

export async function onRequestPost({ request, env }) {
  let user;
  try {
    user = await verifyAccess(request, env);
  } catch (e) {
    return json({ error: "Not authorized" }, 403);
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Bad origin" }, 403);

  try {
    const db = supabase(env);
    const lastRes = await db("prism_sync_requests?select=id,requested_at,status&order=id.desc&limit=1");
    const last = lastRes.ok ? (await lastRes.json())[0] : null;
    if (last) {
      const active = last.status === "pending" || last.status === "running";
      const recent = Date.now() - Date.parse(last.requested_at) < COOLDOWN_MS;
      if (active || recent) return json({ queued: false, reason: active ? "already-queued" : "cooldown", request: last });
    }
    const ins = await db("prism_sync_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ requested_by: user.email || null }),
    });
    if (!ins.ok) return json({ error: "Database error " + ins.status }, 502);
    return json({ queued: true, request: (await ins.json())[0] });
  } catch (e) {
    return json({ error: "Server error: " + e.message }, 500);
  }
}
