# jnu-cli

[![CI](https://github.com/NoodleStormno/jnu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/NoodleStormno/jnu-cli/actions/workflows/ci.yml)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

面向**暨南大学校园服务（本科教务系统、图书馆 OPAC、缴费系统与实验室安全管理系统）**的 Agent-Friendly 命令行工具与 AI Skill。真实接口采用“先抓包、后适配”，未录制接口会失败关闭并返回 `UPSTREAM_NOT_CAPTURED`，不会猜测接口。

把常用教务查询封装成稳定命令和结构化 JSON 输出，供人类终端或 Codex、Claude Code、Cursor 等 AI Agent 直接调用。**不收集账号密码**，通过本机浏览器完成统一身份认证后复用会话。

> 本项目由暨大学生个人开发维护，非官方工具。问题反馈与功能建议欢迎提交 [Issue](https://github.com/NoodleStormno/jnu-cli/issues)。

---

## 核心特性

- **登录走浏览器，日常查询走轻量 HTTP**：`auth login` 与 `silab login` 打开浏览器让你亲自完成统一身份认证，会话 Cookie 导出本机 `~/.jnu-cli/`（权限 `0600`）。已适配模块使用 Node.js 原生 `fetch` 查询，无需每次启动浏览器；未录制接口会返回 `UPSTREAM_NOT_CAPTURED`。
- **Agent 原生设计**：所有命令统一输出 `{ ok, command, data | error }`，错误码与退出码一一对应（`LOGIN_REQUIRED`、`UPSTREAM_CHANGED`、`NETWORK_ERROR` 等），无需解析自然语言报错。
- **配套 Agent Skill**：内置 [`skills/jnu-cli-skill/SKILL.md`](skills/jnu-cli-skill/SKILL.md)，定义命令路由、登录续期流程与隐私边界。
- **内置接口录制器**：`jnu-cli dev capture` 可在真实浏览器里录制 JSON XHR/fetch 响应；`dev import-har` 可转换浏览器导出的 HAR，方便安全扩展新模块。
- **离线契约测试**：通过 `JNU_BACKEND=mock` 驱动离线 Fixture 测试，无需联网或登录即可跑通全部单测。

---

## 安装与快速开始

环境要求：**Node.js >= 20**，本机已安装 Google Chrome 或 Microsoft Edge（或通过 Playwright 安装 Chromium），并处于校园网或已连接暨南大学 VPN。

### 1. 克隆并安装

```bash
git clone https://github.com/NoodleStormno/jnu-cli.git
cd jnu-cli
npm install
npm link        # 可选：将 jnu-cli 链接到全局 PATH
```

### 2. 安装给 AI Agent（可选）

```bash
npx skills add https://github.com/NoodleStormno/jnu-cli --skill jnu-cli-skill --global
```

### 3. 检查环境与登录

```bash
jnu-cli doctor
jnu-cli auth login
jnu-cli auth status
```

`auth login` 会弹出 Chrome/Edge 打开暨大教务入口 `https://jw.jnu.edu.cn/new/index.html`，页面自动跳转 ICAS/auth4 统一认证。请自行完成扫码或账号登录；CLI 检测到教务会话后保存 `.jnu.edu.cn` Cookie。

---

## 命令一览

命令状态分为三类：

- **可用**：本地命令或已验证入口可直接运行。
- **已适配，需抓包**：模块已保留；真实请求只有在接口经过验证抓包后才能运行，否则失败关闭并返回 `UPSTREAM_NOT_CAPTURED`。
- **已移除**：`gym`、`lms`、`usc services`、`usc tasks` 无暨南大学对应系统，不再出现在命令表或帮助中。`fee unpaid` 属于 `fee.jnu.edu.cn` 交费大厅，继续保留。

| 模块 | 命令 | 说明 |
|---|---|---|
| 环境诊断 | `jnu-cli doctor [--offline]` | 可用：检查 Node 版本、Playwright、本地会话文件及 `jw.jnu.edu.cn` 连通性 |
| 认证管理 | `jnu-cli auth login [--browser chrome\|edge\|chromium]` | 可用：打开浏览器完成统一身份认证并保存教务会话 |
| | `jnu-cli auth status` | 可用：调用已验证的 `userDesktopInfo.json`（必要时回退 `getCurrentLocale.json`）检查教务会话 |
| | `jnu-cli auth refresh` | 可用：从浏览器 Profile 静默重新进入教务入口并续期会话 |
| | `jnu-cli auth logout` | 可用：清除本机保存的 `session.json` 与浏览器 Profile |
| 学期校历 | `jnu-cli term current [--term YYYY-N]` | 已适配，需抓包：查询当前学年学期与当前教学周 |
| 个人课表 | `jnu-cli course today [--date YYYY-MM-DD]` | 已适配，需抓包：查询今天或指定日期的课程安排 |
| | `jnu-cli course list [--term YYYY-N] [--week N] [--weekday 1..7]` | 已适配，需抓包：查询指定学期、教学周、星期的课表 |
| | `jnu-cli course export-ics [--week N \| --from-week M --to-week N] [--out a.ics]` | 已适配，需抓包：导出 RFC 5545 `.ics` 日历文件 |
| 成绩与学分 | `jnu-cli grade list [--term YYYY-N]` | 已适配，需抓包：查询学期成绩单、本地计算绩点及官方排名汇总 |
| | `jnu-cli grade credits` | 已适配，需抓包：查询毕业学分修读进度与分数段分布 |
| | `jnu-cli cet list [--level 4\|6]` | 已适配，需抓包：查询四六级笔试总分与分项成绩 |
| 考试安排 | `jnu-cli exam weeks [--term YYYY-N]` | 已适配，需抓包：查询学期内设置的考试周 |
| | `jnu-cli exam list [--term YYYY-N] [--type 类别] [--week-id ID]` | 已适配，需抓包：查询考试科目、日期、时间、时长与考场地点 |
| 空闲教室 | `jnu-cli classroom campuses` | 已适配，需抓包：查询全校校区列表与代码 |
| | `jnu-cli classroom buildings [--campus 校区]` | 已适配，需抓包：查询指定校区下的教学楼列表 |
| | `jnu-cli classroom empty --building 教学楼 [--campus 校区] [--date YYYY-MM-DD] [--sections 1-4]` | 已适配，需抓包：查询指定教学楼在目标日期与节次范围内的空闲教室 |
| 教务通知 | `jnu-cli notice list [--category all\|education\|college] [--search 关键词] [--limit 20]` | 已适配，需抓包：查询教务部与院系发布的通知公告 |
| 毕业审核 | `jnu-cli completion summary` | 已适配，需抓包：查询毕业学分总体完成率与学分明细 |
| | `jnu-cli completion courses [--category 代码] [--search 关键词]` | 已适配，需抓包：查询毕业审核课程完成情况清单 |
| 培养方案 | `jnu-cli program view [--category 分组] [--search 关键词]` | 已适配，需抓包：查看个人培养方案与课程表 |
| 全校开课 | `jnu-cli catalog search [--term YYYY-N] [--name 课程] [--teacher 教师] [--campus 校区]` | 已适配，需抓包：检索全校开课课程 |
| 学籍预警 | `jnu-cli profile view` | 已适配，需抓包：查看个人学籍信息与学业预警状态 |
| 图书检索 | `jnu-cli library search --query 关键词 [--field any\|title\|author\|isbn\|callno] [--lang zh\|en] [--campus 校区]` | 已适配，需抓包：免登录检索暨南大学图书馆（`lib.jnu.edu.cn`）馆藏书目与馆藏分布 |
| | `jnu-cli library holdings --doc 书目号 [--lang zh\|en] [--campus 校区] [--available]` | 已适配，需抓包：免登录查询指定书目的单册借阅状态与架位 |
| 交费大厅 | `jnu-cli fee unpaid` | 已适配，需抓包：查询暨南大学交费大厅（`fee.jnu.edu.cn`）个人待缴费用账单 |
| 实验室安全 | `jnu-cli silab login [--browser chrome\|edge\|chromium]` | 可用：打开浏览器登录实验室安全管理系统（`silab.jnu.edu.cn`），只保存会话 Cookie |
| | `jnu-cli silab status` | 可用：检查本地 SILab 会话是否已保存（不做网络探测） |
| 开发工具 | `jnu-cli dev capture [--url URL]` | 可用：打开浏览器录制 JSON XHR/fetch 响应，用于安全地分析新接口 |
| | `jnu-cli dev import-har --file <HAR> [--out <capture.json>]` | 可用：将浏览器导出的 HAR 转换为 capture JSON，并过滤非 JSON/非 XHR 响应 |

> **学期参数格式**：`YYYY-N`（其中 `YYYY` 为学年起始年份，例如 `2026-1` 表示 2026–2027 学年第一学期；同样兼容 `2026-2027-1`）。省略 `--term` 时默认查询当前学期。

---

## 输出示例

```bash
$ jnu-cli course today
```

```json
{
  "ok": true,
  "command": "course today",
  "data": {
    "term": "2026-1",
    "termLabel": "2026-2027 学年第一学期",
    "date": "2026-10-23",
    "week": 7,
    "currentWeek": 7,
    "weekday": 5,
    "weekdayName": "周五",
    "count": 2,
    "courses": [
      {
        "term": "2026-1",
        "week": 7,
        "weekday": 5,
        "weekdayName": "周五",
        "date": "2026-10-23",
        "startSection": 1,
        "endSection": 2,
        "sections": "1-2",
        "courseName": "数据结构与算法",
        "teacher": "张老师",
        "location": "东校园公教楼B201",
        "classCode": "202600001"
      }
    ]
  }
}
```

---

## 架构

```text
User / AI Agent
  -> jnu-cli CLI (src/main.js, structured JSON contract)
  -> Domain modules (term / course / grade / exam / auth / doctor / dev)
  -> Pure parsers (src/parsers/*-parser.js)
  -> JwxtClient (src/lib/jwxt.js, Node fetch + CookieJar, ~/.jnu-cli/session.json)
  -> JNU systems after verified capture (jw.jnu.edu.cn / lib.jnu.edu.cn / ...)
```

完整返回格式与错误码说明见 [docs/cli-contract.md](docs/cli-contract.md)。

---

## 安全与合规边界

- **不碰密码**：CLI 从不读取或保存 NetID 账号密码。
- **不绕过验证**：不绕过统一身份认证、WebVPN、极验（Geetest）滑块、企业微信扫码、访问频率限制或校园网/VPN 限制。
- **失败关闭**：真实接口未完成验证抓包时返回 `UPSTREAM_NOT_CAPTURED`，不会猜测路径或参数继续请求。
- **只读与低频按需优先**：内置请求节流（`paceRequest`）与跨进程冷却锁（`enforceActionCooldown`），限制高频轮询、并发爬虫和自动重试循环。
- **本地隔离**：Cookie 与录制文件仅保存在 `~/.jnu-cli/`，已在 `.gitignore` 中排除，请勿手动提交或分享。

---

## 开发与测试

```bash
npm test
```

## 许可证

[MIT](LICENSE)
