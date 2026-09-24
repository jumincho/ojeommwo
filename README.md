<div align="center">

**🇺🇸 English** · [🇨🇳 简体中文](README.zh-CN.md) · [🇭🇰 繁體中文](README.zh-HK.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md)

<img src="observatory/public/og.png" alt="Ojeommwo Menu Observatory: menus drawn as a galaxy of stars" width="100%">

# Ojeommwo · 오점뭐

**What's for lunch today?** A Slack bot that picks weekday lunch and dinner for a university lab,<br>
and a 3D observatory that turns every pick into a map of shared taste.

[**Open the observatory**](https://ojeommwo-observatory.jumincho.chatgpt.site/) · [How it works](#how-it-works) · [Run it locally](#run-it-locally)

</div>

## Overview

*Ojeommwo* (오점뭐) is short for 오늘 점심 뭐 먹지?, Korean for "what's for lunch today?". It serves a research lab at Jeonbuk National University in Jeonju, Korea.

On weekdays at 11:25 and 17:25 KST, skipping public holidays, the bot posts three delivery picks to Slack, each from a different category, restaurant and dish. Lab members rate the picks and log what they actually ate. Those signals update a Bayesian taste model that shapes the next round, and the **Menu Observatory** publishes a sanitized view of the whole history.

## Features

### Slack bot

- **Three distinct picks per meal.** A different category, restaurant and dish every time. Cooldowns keep a restaurant away for 14 days and a menu for 7.
- **Only verified candidates.** Each pick is checked for meal suitability, the actual branch, a price seen within 7 days and delivery evidence within 3 days, inside a 6 km radius. Closures and paused delivery remove a candidate.
- **19 meal categories.** 한식, 치킨, 분식, 돈까스, 족발/보쌈, 찜/탕, 구이, 피자, 중식, 일식, 회/해물, 양식, 아시안, 샌드위치, 샐러드, 버거, 멕시칸, 도시락 and 죽. Standalone drinks, desserts and snacks are excluded.
- **Feedback in Slack.** Rate recommended menus from 1 to 5 with up to three tags, log meals (including ones that were not recommended), and answer the "coffee later?" poll.
- **Official weather.** Current, feels-like, high and low temperature, humidity, precipitation, weather warnings, UV and fine dust from the Korea Meteorological Administration and AirKorea.
- **An LLM where judgement helps, code everywhere else.** GPT-6 Luna (xhigh reasoning, through the Codex CLI) researches new candidates on the web, normalizes loosely typed meal logs and re-adjudicates ambiguous categories. It runs in a read-only sandbox and returns schema-validated JSON. Ranking, preference math, expiry, deduplication and storage are deterministic, tested code.

### Menu Observatory

- **3D Menu Cosmos** (3D 코스모스): categories are glowing hubs and menus orbit them as stars. Drag to rotate, scroll to zoom, click a star for details.
- **Taste Map** (취향 지도): every menu sits on a *dislike 0% · neutral 50% · like 100%* axis, one lane per category. Direction is shown with text, colour, symbol and pattern together, and a ranked list view is one click away.
- **Filters and search.** Select several categories at once, or search by menu, restaurant or main ingredient (try `pork`).
- **Menu details.** Preference, times recommended, times eaten, rating count and average, price and delivery freshness.
- **Menu browsing** (메뉴 둘러보기): five random menus along the bottom; press 다시 뽑기 to draw again.
- **Accessible by default.** Keyboard navigation, reduced-motion support and a fallback when WebGL is unavailable. The page loads once and never refreshes itself.

The observatory interface is in Korean.

## How it works

```mermaid
flowchart TB
  llm["LLM via Codex CLI<br/>read-only sandbox"]
  weather["KMA · AirKorea"]
  subgraph bot["Bot server · Node.js 22 · cron"]
    refresh["Candidate refresh<br/>08:50 · 11:35<br/>15:00 · 17:35"]
    post["Meal post<br/>11:25 · 17:25"]
    store[("JSON stores<br/>locked, atomic writes")]
    listener["Socket Mode listener"]
    export["Snapshot export<br/>every 10 min"]
  end
  slack["Slack"]
  edge["Edge worker + R2"]
  browser["Menu Observatory"]

  llm <--> refresh
  weather --> post
  refresh --> store
  store --> post
  post -->|"3 picks + weather"| slack
  slack -->|"ratings · meal logs · coffee"| listener
  listener --> store
  store --> export
  export -->|"sanitized snapshot"| edge
  edge --> browser
```

- **Candidates are prepared before posts.** Research and posting are separate jobs, so a failed search never becomes a failed post. Before each meal the bot re-verifies prices, delivery evidence, distance, cooldowns and diversity. It searches the web only when the verified pool runs short, plus one optional search for a new restaurant at 11:35.
- **Taste model.** Each menu has a Beta posterior that starts from a Beta(3, 3) prior. Meal logs weigh 1.0 and survey ratings 0.9, evidence decays with a 180-day half-life, and an 18% exploration rate keeps new options in rotation. Repeat votes by one person are damped: only the latest vote counts within a day, and the latest three days count at 1, 0.5 and 0.25. The result is a ranking signal, not a promise of satisfaction.
- **Safe storage.** JSON files with locks, atomic rename, fsync and integrity checks. Slack delivery goes through an outbox, so an uncertain send is never blindly repeated.
- **Observatory pipeline.** Every ten minutes the server validates the database, exports a sanitized snapshot and publishes it to an edge worker backed by R2 object storage. Browsers read the latest snapshot when the page opens.

## Tech stack

| Part | Built with |
| --- | --- |
| Bot | Node.js 22+ with no npm dependencies, Slack Web API and Socket Mode, Codex CLI |
| Data | KMA and AirKorea open APIs, JSON stores |
| Observatory | Next.js 16, React 19, vinext (Vite 8), TypeScript, three.js, 3d-force-graph |
| Hosting | Workers-style edge function with R2 storage; a static export doubles as an offline viewer |

## Repository layout

```text
.
├── src/             Slack bot: recommender, candidate research, taste model, weather, storage
├── scripts/         Operational CLIs: health checks, audits, candidate refresh, scheduled posts
├── test/            Test suite for the bot
├── prompts/         JSON schemas for structured LLM output
├── config/          Restaurant and menu normalization aliases
├── data/            Seed menus and the holiday calendar (no operating data)
└── observatory/     Menu Observatory
    ├── app/         React UI: 3D cosmos, taste map, filters, detail panel, browsing strip
    ├── worker/      Edge worker: snapshot API, publish authentication, security headers
    ├── scripts/     Snapshot export, validation and publishing
    ├── tests/       Observatory tests
    └── public/data/ Sanitized sample snapshot for local preview
```

## Run it locally

### Observatory (no credentials needed)

Requires Node.js 22.13 or later with Corepack.

```sh
cd observatory
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open the URL the dev server prints. Without the snapshot API, the app falls back to the sample in `public/data/snapshot.json`.

```sh
corepack pnpm lint
corepack pnpm typecheck
```

`corepack pnpm test` runs too, but a few suites rebuild the snapshot from the operating database, which is not part of this repository, so they fail here.

### Bot

Requires Node.js 22 or later.

```sh
npm run check   # syntax and JSON checks
npm test        # unit tests; no Slack workspace or credentials needed
```

To run the bot in your own workspace, copy `.env.example` to `.env` and fill in a Slack bot token and an app-level token for Socket Mode, plus a data.go.kr service key if you want weather. Candidate research also needs a Codex CLI login. `npm run dry-run` builds a recommendation and prints it without posting.

## Privacy and security

- No tokens, API keys, OAuth state, logs or operating database are committed. Secrets live in `.env` and in protected files outside the project.
- The public snapshot holds aggregates only: menus, restaurants, categories, preference posteriors and counts. It contains no Slack user IDs, messages or channel data, and a validator rejects forbidden fields before anything is published.
- Publishing a snapshot requires a bearer token. For everyone else the site is read-only, served with a strict Content Security Policy, HSTS and anti-framing headers.

## Status

Version **2.6**, launched on 2026-09-23. The release is labelled *GPT-6 Sol Max (Daybreak Blue)*; the production model is GPT-6 Luna with xhigh reasoning.

Design notes (in Korean): [ARCHITECTURE.md](ARCHITECTURE.md) · [RELEASES.md](RELEASES.md) · [observatory/ARCHITECTURE.md](observatory/ARCHITECTURE.md) · [observatory/DESIGN.md](observatory/DESIGN.md)
