# prismhr-roster (test)

Read-only roster for one PrismHR client, shown at **prismhr.emplovaplans.com** behind Cloudflare Access.

```
PrismHR API ──(fixed IP, nightly + on demand)──> sync server ──> Supabase ──> Cloudflare Pages site (/api/roster)
                                                                 └─ Cloudflare Access (@emplova.com only)
```

- The website never calls PrismHR, and no PrismHR credentials live on Cloudflare.
- Supabase tables have Row Level Security on and no policies, so only server-side code with the secret key can read them.
- `/api/roster` verifies the Cloudflare Access token itself (fails closed), so the `*.pages.dev` address can't bypass the login.
- Only name, employee ID, job title, status and hire date are stored.

## Layout
| Path | What |
|---|---|
| `supabase/schema.sql` | Run once in Supabase SQL Editor |
| `sync/prismhr_sync.py` | Sync script (Python 3 standard library only) |
| `sync/install.sh` | One-command installer for an Ubuntu server; prompts for secrets, sets the nightly sync + every-minute refresh check |
| `public/index.html` | The page |
| `functions/api/roster.js` | Cloudflare Pages Function that reads Supabase |
| `functions/api/refresh.js` | Records a "refresh now" request |
| `lib/shared.js` | Shared login check (Access JWT) and Supabase helper |

## Cloudflare Pages settings
- Build command: *(none)* · Build output directory: `public` · Root directory: *(blank / repo root)*
- Variables & Secrets: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (secret), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, optional `CLIENT_ID`, `CLIENT_NAME`

## PrismHR Web Service User
Allowed methods: `LoginService.createPeoSession`, `LoginService.keepAlive`, `LoginService.invalidateSession`,
`ClientMasterService.getClientList`, `EmployeeService.getEmployeeList`, `EmployeeService.getEmployee#PERSON|CLIENT`.
Allowed IPs: the sync server's fixed IP.

## Refresh button
The page's **Refresh from PrismHR** button calls `POST /api/refresh`, which adds a row to `prism_sync_requests`
(login required, one request at a time, at most one per minute). The sync server checks every minute
(`prismhr_sync.py --if-requested`) and only contacts PrismHR when a request is pending. A full sync also runs nightly.

## Sync server
```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/jeffreymelesky/prismhr-roster/main/sync/install.sh)"
python3 /opt/prismhr-sync/prismhr_sync.py      # run manually
tail -f /var/log/prismhr-sync.log              # watch runs
```
