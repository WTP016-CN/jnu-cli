# jnu-cli Agent & Contributor Guide

`jnu-cli` is an agent-friendly CLI for Jinan University campus services (`jw.jnu.edu.cn`, `lib.jnu.edu.cn` OPAC, `fee.jnu.edu.cn`, and `silab.jnu.edu.cn`).

## Design Principles

1. **Browser for login, plain HTTP for queries**: Playwright is only launched for `auth login`, `auth refresh`, `silab login`, and `dev capture`. Daily queries use Node.js `fetch` with tokens/cookies saved in `~/.jnu-cli/session.json` (`0600`).
2. **Structured JSON contract**: Every command writes `{ ok: true, command, data }` or `{ ok: false, command, error: { code, message, hint?, details? } }` to stdout and exits with a deterministic code (`0` ok, `2` usage/args, `3` auth, `4` upstream/permission/rate-limit, `5` network, `6` browser).
3. **Strict safety & anti-high-frequency boundary**:
   - Never ask for, accept, or store NetID passwords.
   - Never bypass unified authentication, WebVPN, Geetest slider verification, Safeline WAF, WeCom QR login, rate limits, or campus-network / VPN access controls.
   - Fail closed when a real upstream interface has not been verified through captured traffic; return `UPSTREAM_NOT_CAPTURED` instead of guessing endpoints or parameters.
   - **Prohibit high-frequency access**: All HTTP requests pass through `src/lib/rate-limit.js` (`paceRequest` for in-process pacing and `enforceActionCooldown` for cross-process action cooldowns). Never implement high-frequency polling, burst scraping, or automated retry loops.
   - Never commit `session.json`, `rate-limit.json`, browser profiles, or `dev capture` output.

## Command Availability

- **Available**: `doctor`, `auth login`, `auth refresh`, `auth status`, `auth logout`, `silab login`, `silab status`, `dev capture`, and `dev import-har`.
- **Adapted, capture required**: JWXT query commands, `library search`, `library holdings`, and `fee unpaid` remain in the command table, but real requests fail closed with `UPSTREAM_NOT_CAPTURED` until the corresponding JNU endpoints are verified.
- **Removed**: `gym`, `lms`, `usc services`, and `usc tasks` have no corresponding JNU system and are not part of the command table. `fee unpaid` belongs to `fee.jnu.edu.cn`, not USC, and remains supported.

## Repository Layout

- `src/cli.js`: binary entrypoint.
- `src/main.js`: declarative command table (`COMMANDS`) and JSON output envelope.
- `src/lib/`: `jwxt.js` (HTTP + mock client), `rate-limit.js` (pacing & cooldown lock), `cookies.js`, `state.js`, `browser.js`, `args.js`, `errors.js`, `paths.js`.
- `src/modules/`: one file per domain (`auth`, `term`, `course`, `grade`, `exam`, `classroom`, `cet`, `notice`, `completion`, `program`, `catalog`, `profile`, `library`, `fee`, `silab`, `doctor`, `dev`).
- `src/parsers/`: pure functions that turn raw upstream payloads into stable JSON shapes.
- `skills/jnu-cli-skill/SKILL.md`: agent operating instructions and anti-high-frequency rules.
- `tests/`: `node --test` unit and contract tests backed by `JNU_BACKEND=mock`.

## Verification

Run `npm test` before every commit. All tests must pass offline via `JNU_BACKEND=mock`.
