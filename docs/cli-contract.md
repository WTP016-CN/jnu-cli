# CLI Contract (`jnu-cli`)

Every invocation prints a single JSON object to `stdout`. Diagnostic progress (such as `auth login` browser prompts) goes to `stderr`.

## Success Envelope

```json
{
  "ok": true,
  "command": "course today",
  "data": { ... }
}
```

## Error Envelope & Exit Codes

```json
{
  "ok": false,
  "command": "course list",
  "error": {
    "code": "LOGIN_REQUIRED",
    "message": "No saved JNU session was found.",
    "hint": "Run `jnu-cli auth refresh` ... or `jnu-cli auth login` ..."
  }
}
```

| Exit code | `error.code` | Meaning |
|---|---|---|
| `0` | — | Success |
| `2` | `UNKNOWN_COMMAND`, `INVALID_ARGUMENT` | CLI usage error; fix arguments and do not retry blindly |
| `3` | `LOGIN_REQUIRED`, `AUTH_LOGIN_INCOMPLETE`, `AUTH_LOGIN_TIMEOUT` | Session missing or expired; run `auth refresh` or `auth login` |
| `4` | `PERMISSION_DENIED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `UPSTREAM_CHANGED`, `UPSTREAM_NOT_CAPTURED` | Upstream rejected, rate-limited, changed, or has not yet been captured; capture the endpoint before continuing |
| `5` | `NETWORK_ERROR` | Cannot reach the required JNU service (campus network or JNU VPN may be required) |
| `6` | `BROWSER_UNAVAILABLE`, `BROWSER_BUSY`, `BACKEND_UNAVAILABLE` | Local browser / Playwright issue |

## Command Availability

The command table has three availability states:

- **Available**: `doctor`, `auth login`, `auth refresh`, `auth status`, `auth logout`, `silab login`, `silab status`, `dev capture`, and `dev import-har`.
- **Adapted, capture required**: JWXT query commands, `library search`, `library holdings`, and `fee unpaid` remain implemented, but real requests fail closed with `UPSTREAM_NOT_CAPTURED` until their JNU endpoints have been verified through captured traffic.
- **Removed**: `gym`, `lms`, `usc services`, and `usc tasks` have no corresponding JNU system and are not registered in `COMMANDS`. `fee unpaid` is a `fee.jnu.edu.cn` command and remains available in the adapted, capture-required group.

`UPSTREAM_NOT_CAPTURED` is a hard stop. Do not guess endpoints, parameters, or
response shapes, and do not bypass JNU unified authentication, WebVPN,
verification challenges, rate limits, or campus-network access controls.

## Term Format

`--term` accepts:
- `current` (default when omitted)
- `YYYY-N`, where `YYYY` is the start year of the academic year (`2026-1` = 2026–2027 学年第一学期, `2025-2` = 2025–2026 学年第二学期)
- `YYYY-YYYY-N` (`2026-2027-1`), automatically normalized to `YYYY-N`

## Authentication

`auth login` opens `https://jw.jnu.edu.cn/new/index.html`, which redirects to the
JNU ICAS/auth4 unified login. The CLI never fills or stores credentials.

`auth status` uses only these verified endpoints:

- `GET https://jw.jnu.edu.cn/jsonp/userDesktopInfo.json?type=`
- fallback: `GET https://jw.jnu.edu.cn/jsonp/getCurrentLocale.json`

Both are exempt from the `UPSTREAM_NOT_CAPTURED` guard for authentication
verification. All other uncaptured academic endpoints remain guarded.
