#!/usr/bin/env python3
"""
PrismHR -> Supabase roster sync (test).

Runs on a server whose fixed IP is in the PrismHR Web Service User's Allowed IPs.
Standard library only, no pip installs needed.

Settings are read from /opt/prismhr-sync/.env (or the path in PRISM_ENV_FILE):
  PRISM_BASE_URL   e.g. https://api.prismhr.com/api-1.30/services/rest/
  PRISM_USER       your Web Service User ID
  PRISM_PASSWORD   (secret)
  PRISM_PEO_ID     your PEO ID
  PRISM_CLIENT_ID  client to sync
  SUPABASE_URL     e.g. https://abcd1234.supabase.co
  SUPABASE_SECRET_KEY  service_role or sb_secret_ key (secret)

Only these fields are stored: name, job title, status, hire date.
SSN, date of birth, pay, address etc. are never written to Supabase.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ENV_FILE = os.environ.get("PRISM_ENV_FILE", "/opt/prismhr-sync/.env")
TIMEOUT = 60


def load_env(path):
    cfg = {}
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    for k in list(cfg):
        cfg[k] = os.environ.get(k, cfg[k])
    return cfg


def http(method, url, headers=None, data=None):
    body = None
    if data is not None:
        body = data if isinstance(data, bytes) else data.encode()
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode() or ""
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


# ---------------- PrismHR ----------------

class Prism:
    def __init__(self, base, user, password, peo):
        self.base = base if base.endswith("/") else base + "/"
        self.user, self.password, self.peo = user, password, peo
        self.session = None

    def login(self):
        form = urllib.parse.urlencode({"username": self.user, "password": self.password, "peoId": self.peo})
        status, raw = http("POST", self.base + "login/createPeoSession",
                           {"Accept": "application/json",
                            "Content-Type": "application/x-www-form-urlencoded"}, form)
        j = _json(raw)
        if not j.get("sessionId"):
            raise RuntimeError(f"PrismHR login failed (HTTP {status}): {j.get('errorMessage') or raw[:300]}")
        self.session = j["sessionId"]

    def get(self, path, params):
        q = urllib.parse.urlencode(params, doseq=True)
        status, raw = http("GET", f"{self.base}{path}?{q}",
                           {"Accept": "application/json", "sessionId": self.session})
        j = _json(raw)
        if str(j.get("errorCode", "0")) != "0":
            raise RuntimeError(f"{path} error {j.get('errorCode')}: {j.get('errorMessage')}")
        if status >= 400:
            raise RuntimeError(f"{path} HTTP {status}: {raw[:300]}")
        return j

    def logout(self):
        if not self.session:
            return
        form = urllib.parse.urlencode({"sessionId": self.session})
        http("POST", self.base + "login/invalidateSession",
             {"Accept": "application/json", "sessionId": self.session,
              "Content-Type": "application/x-www-form-urlencoded"}, form)


def _json(raw):
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def flatten(d, prefix=""):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out.update(flatten(v, key))
            elif isinstance(v, list):
                if v and isinstance(v[0], dict):
                    out.update(flatten(v[0], key))
                else:
                    out[key] = v
            else:
                out[key] = v
    return out


def pick(flat, candidates):
    """Return the first non-empty value whose key (last segment, case-insensitive) matches a candidate."""
    lowered = {k.split(".")[-1].lower(): v for k, v in flat.items()}
    full = {k.lower(): v for k, v in flat.items()}
    for c in candidates:
        c = c.lower()
        v = full.get(c) if "." in c else lowered.get(c)
        if v not in (None, "", []):
            return str(v)
    return None


FIELD_MAP = {
    "first_name": ["firstName", "preferredName"],
    "last_name": ["lastName"],
    "job_title": ["jobTitle", "positionDescription", "jobCodeDescription", "jobDescription", "position", "jobCode"],
    "status": ["employeeStatus", "employmentStatus", "statusDescription", "empStatus", "statusType", "status"],
    "hire_date": ["lastHireDate", "hireDate", "originalHireDate", "peoStartDate"],
}


# ---------------- Supabase ----------------

class Supa:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Content-Type": "application/json"}
        if key.startswith("eyJ"):  # legacy JWT-style service_role key
            self.h["Authorization"] = "Bearer " + key

    def call(self, method, path, body=None, prefer=None):
        h = dict(self.h)
        if prefer:
            h["Prefer"] = prefer
        status, raw = http(method, self.base + path, h,
                           json.dumps(body) if body is not None else None)
        if status >= 300:
            raise RuntimeError(f"Supabase {method} {path.split('?')[0]} HTTP {status}: {raw[:300]}")
        return _json(raw) if raw else None


# ---------------- main ----------------

def main():
    cfg = load_env(ENV_FILE)
    need = ["PRISM_BASE_URL", "PRISM_USER", "PRISM_PASSWORD", "PRISM_PEO_ID",
            "PRISM_CLIENT_ID", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]
    missing = [k for k in need if not cfg.get(k)]
    if missing:
        print("Missing settings:", ", ".join(missing))
        return 2

    client = cfg["PRISM_CLIENT_ID"]
    supa = Supa(cfg["SUPABASE_URL"], cfg["SUPABASE_SECRET_KEY"])
    run = supa.call("POST", "prism_sync_runs", {"client_id": client}, prefer="return=representation")
    run_id = run[0]["id"] if run else None
    started = datetime.now(timezone.utc).isoformat()

    prism = Prism(cfg["PRISM_BASE_URL"], cfg["PRISM_USER"], cfg["PRISM_PASSWORD"], cfg["PRISM_PEO_ID"])
    ok, msg, count, field_names = False, "", 0, set()
    try:
        prism.login()
        lst = prism.get("employee/getEmployeeList", {"clientId": client})
        el = lst.get("employeeList") or {}
        ids = as_list(el.get("employeeId") if isinstance(el, dict) else el)
        ids = [str(i) for i in ids if i]

        rows = []
        options = cfg.get("PRISM_OPTIONS", "Person,Client")
        for i in range(0, len(ids), 20):
            batch = ids[i:i + 20]
            data = prism.get("employee/getEmployee",
                             {"clientId": client, "employeeId": batch, "options": options})
            for emp in as_list(data.get("employee")):
                flat = flatten(emp)
                field_names.update(flat.keys())
                emp_id = str(emp.get("id") or emp.get("employeeId") or "")
                row = {"client_id": client, "employee_id": emp_id, "synced_at": started}
                for col, cands in FIELD_MAP.items():
                    row[col] = pick(flat, cands)
                if emp_id:
                    rows.append(row)

        if rows:
            supa.call("POST", "prism_employees?on_conflict=client_id,employee_id", rows,
                      prefer="resolution=merge-duplicates,return=minimal")
        # remove employees no longer returned by PrismHR for this client
        supa.call("DELETE", "prism_employees?client_id=eq." + urllib.parse.quote(client)
                  + "&synced_at=lt." + urllib.parse.quote(started), prefer="return=minimal")
        ok, count = True, len(rows)
        msg = f"Synced {count} of {len(ids)} employees"
    except Exception as e:  # noqa: BLE001
        msg = str(e)[:500]
    finally:
        prism.logout()

    if run_id is not None:
        supa.call("PATCH", f"prism_sync_runs?id=eq.{run_id}", {
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "ok": ok, "employee_count": count, "message": msg,
            "field_names": ", ".join(sorted(field_names))[:4000],
        }, prefer="return=minimal")
    print(("OK: " if ok else "FAILED: ") + msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
