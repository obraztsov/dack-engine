#!/usr/bin/env python3
"""X OAuth2 **secrets provider** for DACK — trusted, harness-owned, seamed via
`dack.config.yaml` (`secrets_providers: [{name: x, command: [...x_oauth2.py]}]`).

The harness runs this with the provider's config env and reads a single JSON object
`{"X_BEARER_TOKEN": "<valid access token>"}` from stdout. It owns everything sensitive — the
client secret, the rotating refresh token, and the token store — so a *sensor* never does
(a sensor is arbitrary Reflect-authored code; see docs/SECRETS-AND-SANDBOX.md).

**Rotate only when needed.** The store keeps `expires_at`; we refresh only when the cached
token is within `X_REFRESH_SKEW` of expiry — *no API call is burned to validate*, since the
token is used across many sensor runs. stdlib only (urllib).

Config env:
  X_CREDS_FILE   — labelled bootstrap creds (Client ID/secret + Refresh token @handle).
  X_TOKEN_STORE  — JSON sidecar {access_token, refresh_token, expires_at}; default
                   "<X_CREDS_FILE>.tokens.json". Harness-owned, gitignored, mode 0600.
  X_REFRESH_SKEW — seconds-of-life threshold to refresh early (default 300).
"""
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

TOKEN_URL = "https://api.twitter.com/2/oauth2/token"


def _store_path():
    return os.environ.get("X_TOKEN_STORE", os.environ["X_CREDS_FILE"] + ".tokens.json")


def _load_bootstrap():
    lines = [l.strip() for l in open(os.environ["X_CREDS_FILE"]) if l.strip()]
    raw = {lines[i]: lines[i + 1] for i in range(0, len(lines) - 1, 2)}

    def pick(prefix):
        return next(v for k, v in raw.items() if k.lower().startswith(prefix))

    return {
        "client_id": pick("client id"),
        "client_secret": pick("client secret"),
        "refresh_token": pick("refresh token"),
    }


def _load_store():
    p = _store_path()
    return json.load(open(p)) if os.path.exists(p) else {}


def _save_store(store):
    p = _store_path()
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(store, f)


def _refresh(client_id, client_secret, refresh_token):
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    body = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "refresh_token": refresh_token}
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    return json.load(urllib.request.urlopen(req, timeout=25))


def main():
    boot = _load_bootstrap()
    store = _load_store()
    skew = int(os.environ.get("X_REFRESH_SKEW", "300"))
    now = int(time.time())

    # Validity check by stored timestamp — cheap, burns no API call.
    if store.get("access_token") and store.get("expires_at", 0) - skew > now:
        print(json.dumps({"X_BEARER_TOKEN": store["access_token"]}))
        return 0

    # Refresh (prefer the store's rotated refresh token; fall back to bootstrap on first run).
    refresh_token = store.get("refresh_token") or boot["refresh_token"]
    tok = _refresh(boot["client_id"], boot["client_secret"], refresh_token)
    new = {
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token", refresh_token),
        "expires_at": now + int(tok.get("expires_in", 7200)),
    }
    _save_store(new)  # persist BEFORE printing — the old refresh token is now spent
    print(json.dumps({"X_BEARER_TOKEN": new["access_token"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
