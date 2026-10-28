// Cloudflare Pages Function: GET /api/roster
// Reads the roster from Supabase using a server-side secret key.
// Fails closed: every request must carry a valid Cloudflare Access token,
// so the *.pages.dev address can't be used to bypass the email login.
//
// Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY   (secret) service_role or sb_secret_ key
//   ACCESS_TEAM_DOMAIN    e.g. yourteam.cloudflareaccess.com
//   ACCESS_AUD            Application Audience (AUD) tag from the Access application
//   CLIENT_ID, CLIENT_NAME  (optional) label shown on the page

import { json, supabase, verifyAccess } from "../../lib/shared.js";

export async function onRequestGet({ request, env }) {
  try {
    await verifyAccess(request, env);
  } catch (e) {
    return json({ error: "Not authorized" }, 403);
  }
  try {
    const db = supabase(env);
    const [empRes, runRes, reqRes] = await Promise.all([
      db("prism_employees?select=employee_id,first_name,last_name,job_title,status,hire_date,synced_at&order=last_name.asc,first_name.asc"),
      db("prism_sync_runs?select=finished_at,ok,employee_count,message&finished_at=not.is.null&order=id.desc&limit=1"),
      db("prism_sync_requests?select=id,requested_at,requested_by,status,processed_at,message&order=id.desc&limit=1"),
    ]);
    if (!empRes.ok) return json({ error: "Database error " + empRes.status }, 502);
    const employees = await empRes.json();
    const runs = runRes.ok ? await runRes.json() : [];
    const reqs = reqRes.ok ? await reqRes.json() : [];
    return json({
      client: { id: env.CLIENT_ID || "", name: env.CLIENT_NAME || "Roster" },
      employees,
      lastSync: runs[0] || null,
      lastRequest: reqs[0] || null,
    });
  } catch (e) {
    return json({ error: "Server error: " + e.message }, 500);
  }
}
