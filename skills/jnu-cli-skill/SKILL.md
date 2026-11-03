---
name: jnu-cli-skill
description: Query and interact with Jinan University (JNU / 暨南大学) campus services via the local `jnu-cli` tool: undergraduate academic services (jw.jnu.edu.cn), library OPAC holdings (lib.jnu.edu.cn), the Payment Hall (fee.jnu.edu.cn), and the laboratory safety system (silab.jnu.edu.cn). Reuses browser login sessions without handling passwords and strictly prohibits high-frequency access.
version: 0.3.0
license: MIT
---

# JNU Campus Services Skill (`jnu-cli`)

`jnu-cli` is the single source of truth. This skill tells the agent which command to run, how to handle its JSON output, and what safety/rate-limit rules must never be violated.

## Strict Anti-High-Frequency & Rate-Limit Rules (严禁高频访问限制)

- **严禁高频访问与轮询（NO High-Frequency Polling or Burst Loops）**：
  - 绝不允许通过 `while`/`for` 循环、定时脚本、后台高频轮询或并发请求连续调用任何 `jnu-cli` 命令（包括但不限于持续监控、自动重试、批量爬取图书馆或全校开课目录）。
  - 每次用户对话回合中，针对同一资源的查询最多执行 **1 次**；如需分页或跟进查询，单回合内总调用次数不得超过 **3 次**。
- **遇到限流立即熔断**：一旦任何命令返回 `error.code === "RATE_LIMITED"` 或 WAF 拦截提示，必须立即停止所有后续调用，不得重试。

## Security & Privacy Rules

- **Never** ask for the user's NetID password, verification code, or cookie files.
- **Never** bypass unified authentication, WebVPN, Geetest slider verification, Safeline WAF, WeCom QR confirmation, rate limits, or campus-network / VPN requirements.
- Fail closed when a real upstream interface has not been verified through captured traffic; return `UPSTREAM_NOT_CAPTURED` instead of guessing endpoints or parameters.
- Run **one** browser login command (`auth login`, `silab login`) at a time.
- Every command outputs JSON `{ ok, command, data | error }`. Parse JSON; do not scrape prose.
- Treat grades, GPA, rank, student identifiers, and wallet balances as private: report only what the user asked for.

## Readiness & Login Flow

1. **JWXT (本科教务系统 `jw.jnu.edu.cn`)**:
   - Check status: `jnu-cli auth status`
   - If `loggedIn: false`, try `jnu-cli auth refresh` once; if it still returns `LOGIN_REQUIRED`, run `jnu-cli auth login` and ask the user to complete login in the opened browser window.
   - JWXT query commands are adapted but require verified captured endpoints in real mode; otherwise they fail closed with `UPSTREAM_NOT_CAPTURED`.
2. **Library OPAC (图书馆馆藏检索)**:
   - No login is required. `jnu-cli library search` and `jnu-cli library holdings` remain available, but real mode requires verified captured OPAC traffic and otherwise fails closed.
3. **SILab (实验室安全管理系统 `silab.jnu.edu.cn`)**:
   - `jnu-cli silab login` opens a browser and saves cookies after the user finishes login.
   - `jnu-cli silab status` only checks the locally saved cookie state.
4. **Payment Hall (交费大厅 `fee.jnu.edu.cn`)**:
   - `jnu-cli fee unpaid` is the supported fee command. Real mode requires verified captured traffic and otherwise fails closed.
5. **Uncaptured and removed systems**:
   - If any command returns `UPSTREAM_NOT_CAPTURED`, ask the user to run `jnu-cli dev capture` (or export a HAR and run `jnu-cli dev import-har --file <path>`), then adapt the module from the recorded traffic.
   - Never guess endpoints, and never bypass JNU unified authentication or WebVPN.
   - `gym`, `lms`, `usc services`, and `usc tasks` have no corresponding JNU system and are not registered commands. Do not invoke or route to them.

## Command Routing

| User intent | Command |
|---|---|
| Current academic year/semester and teaching week | `jnu-cli term current` |
| This week's timetable / a specific week or weekday | `jnu-cli course list [--term YYYY-N] [--week N] [--weekday 1..7]` |
| Today's or a specific date's classes | `jnu-cli course today [--date YYYY-MM-DD]` |
| Export timetable to `.ics` calendar | `jnu-cli course export-ics [--term YYYY-N] [--week N \| --from-week M --to-week N] [--out schedule.ics]` |
| Semester grades, weighted GPA, and rank | `jnu-cli grade list [--term YYYY-N]` |
| Credit completion overview & score distribution | `jnu-cli grade credits` |
| Available exam weeks in a term | `jnu-cli exam weeks [--term YYYY-N]` |
| Exam schedule (all or filtered) | `jnu-cli exam list [--term YYYY-N] [--type "18-19周期末考"\|"10-17周结课考"\|"缓补考"] [--week-id ID]` |
| List campuses / teaching buildings | `jnu-cli classroom campuses` / `jnu-cli classroom buildings [--campus 校区]` |
| Find empty classrooms in a building | `jnu-cli classroom empty --building 教学楼 [--campus 校区] [--date YYYY-MM-DD] [--sections 1-2] [--all]` |
| CET-4 / CET-6 scores | `jnu-cli cet list [--level 4\|6]` |
| Undergraduate Office & college notices | `jnu-cli notice list [--category all\|education\|college] [--search 关键词] [--limit 20]` |
| Graduation credit completion audit | `jnu-cli completion summary` / `jnu-cli completion courses [--category 代码] [--search 关键词]` |
| Personal training program (个人培养方案) | `jnu-cli program view [--category publicRequired\|...] [--search 关键词]` |
| Search university-wide course offerings | `jnu-cli catalog search [--term YYYY-N] [--name 课程名] [--teacher 教师] [--department 院系] [--campus 校区]` |
| Student academic record & warnings | `jnu-cli profile view` |
| Search library books & campus call numbers | `jnu-cli library search --query 关键词 [--field any\|title\|author\|isbn\|callno] [--lang zh\|en] [--campus 校区]` |
| Check per-copy on-shelf status & shelf location | `jnu-cli library holdings --doc 书目号 [--lang zh\|en] [--campus 校区] [--available]` |
| List unpaid bills in JNU Payment Hall | `jnu-cli fee unpaid` |
| Authenticate with SILab | `jnu-cli silab login` |
| Check SILab session state | `jnu-cli silab status` |
| Record JNU endpoints in the browser | `jnu-cli dev capture [--url URL]` |
| Convert a browser HAR into a capture file | `jnu-cli dev import-har --file <HAR> [--out <capture.json>]` |
| Environment / network diagnosis | `jnu-cli doctor` |
| Disconnect & wipe local session | `jnu-cli auth logout` |

Term format is `YYYY-N` where `YYYY` is the start year of the academic year (for example, `2026-1` means the first semester of 2026–2027; `2026-2027-1` is also accepted). Omit `--term` to query the current term.

## Error Handling (`error.code`)

- `LOGIN_REQUIRED` → run `jnu-cli auth refresh` / `jnu-cli auth login` (or `jnu-cli silab login` for SILab) and wait for the user.
- `UPSTREAM_NOT_CAPTURED` → the real JNU endpoint is not recorded yet; use `dev capture` or `dev import-har` with the user, and do not guess the API.
- `RATE_LIMITED` → **stop immediately**; do not retry or loop.
- `BROWSER_UNAVAILABLE` → tell the user to install Chrome/Edge or run `npx playwright install chromium`.
- `BROWSER_BUSY` → another `jnu-cli` browser window is open; wait or ask the user to close it.
- `NETWORK_ERROR` → remind the user that JNU services require the campus network or JNU VPN.
- `UPSTREAM_CHANGED` → re-run once with `--raw` to inspect the raw payload, or use `jnu-cli dev capture` with the user to inspect current endpoints.
