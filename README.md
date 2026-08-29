# ptt-alertor-worker

Cloudflare Workers rewrite of [ptt-alertor](https://github.com/Ptt-Alertor/ptt-alertor) — crawls PTT for new articles and pushes notifications via Telegram. LINE / Messenger / Mail are stubbed (single-function extension points).

## Architecture

```
Cron Trigger (every minute)
  └─ runChecker (src/jobs/checker.ts)
       ├─ fetchBoardIndex (src/crawler/ptt.ts)
       ├─ diff against D1 articles
       └─ enqueue → ARTICLE_QUEUE
             └─ handleArticleBatch (src/jobs/matcher.ts)
                  ├─ resolve keyword/author subs from D1
                  └─ enqueue → DISPATCH_QUEUE
                        └─ handleDispatchBatch (src/jobs/dispatcher.ts)
                              ├─ telegram (full)
                              ├─ line      (stub)
                              ├─ messenger (stub)
                              └─ mail      (stub)

Webhooks
  POST /webhooks/telegram/:secret   parser → apply → D1
Admin (basic auth, base64 in ADMIN_BASIC_AUTH)
  GET    /admin/users
  GET    /admin/boards
  POST   /admin/boards
  DELETE /admin/boards/:name
```

## Mapping from the Go original

| Go (ptt-alertor)                | Workers version                         |
| ------------------------------- | --------------------------------------- |
| jobs/checker.go goroutine       | Cron Trigger + runChecker               |
| messageWorker pool of 300       | Cloudflare Queue with batching          |
| models/board (DynamoDB)         | D1 boards / articles tables             |
| models/user (Redis)             | D1 users + channel_bindings             |
| models/keyword, models/author   | D1 keyword_subs / author_subs           |
| command/command.go              | src/command/parser.ts + apply.ts        |
| channels/{telegram,line,...}    | src/channels/*.ts                       |
| PttMonitor 3-strike restart     | dropped; cron retries each minute       |

## Setup

```
pnpm install   # or npm install / yarn

pnpm db:create                   # paste returned id into wrangler.toml
pnpm db:migrate:local            # for local wrangler dev
pnpm db:migrate:remote           # for production

wrangler queues create ptt-article-events
wrangler queues create ptt-dispatch
wrangler queues create ptt-dlq

wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put ADMIN_BASIC_AUTH    # echo -n "user:pass" | base64

pnpm dev
pnpm deploy
```

## Telegram

After deploying, wire up the bot. The one-step way (Basic Auth via `ADMIN_BASIC_AUTH`) registers the slash-command menu **and** sets the webhook with the secret token in a single call:

```
curl -u <user>:<pass> -X POST https://<your-worker>.workers.dev/admin/telegram/setup
```

Or set the webhook by hand. The `secret_token` is sent back by Telegram on every request as the `X-Telegram-Bot-Api-Secret-Token` header, which the Worker validates (fail-closed if `TELEGRAM_WEBHOOK_SECRET` is not set):

```
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/webhooks/telegram" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Talk to your bot with slash commands:

```
/add                       guided: pick 關鍵字/作者, then reply "<板名> <項目>"
/add Stock 台積電,聯電       one-shot keyword subscribe
/del                       lists your keyword subs as tap-to-delete buttons
/addauthor Gossiping someuser
/delauthor                 lists your author subs as tap-to-delete buttons
/list                      show current subscriptions
/help                      usage
```

### Keyword logic — comma is OR, space is AND

A keyword match is a case-insensitive substring of the article title. Two operators combine them:

- **Comma `,` = OR** — separate keywords; the article notifies if it matches any one.
- **Space ` ` = AND** — within a single keyword, every space-separated term must appear in the title (order/adjacency don't matter).

```
/add Stock 台積電,聯電        台積電 OR 聯電
/add Stock 台積電 漲停        台積電 AND 漲停 (both must be in the title)
/add Stock 台積電 漲停,聯電 跌停   (台積電 AND 漲停) OR (聯電 AND 跌停)
```

Authors are exact IDs, so spaces there just separate multiple IDs (no AND).

The original Chinese free-text grammar still works (`新增 Stock 關鍵字 台積電,聯電`, `刪除 Stock 作者 someuser`, `清單`, `help`).

## Tests

```
pnpm test
pnpm typecheck
```

## Caveats

- Workers Free has a 30s wall-time cap on scheduled events. Many boards x per-board delay can exceed it; bump to Workers Paid or shard boards across multiple cron expressions.
- Queues require the Workers Paid plan ($5/mo).
- Push count and comment trackers from the Go version are not yet ported. Extend `runChecker` to enqueue new event kinds and add handlers in `matcher.ts`.
- Cloudflare may rate-limit outbound `fetch` on the Free plan.

## Known issues / TODO

Found during initial code review. None block local-dev usage; address before serious production traffic.

All initial-review TODOs landed. Fixes:

- ~~**Checker write/enqueue is not atomic**~~ — `src/jobs/checker.ts` + migration `0002_articles_enqueued_at.sql`. Rows insert with `enqueued_at = NULL` and are stamped only after `ARTICLE_QUEUE.sendBatch` resolves; the next sweep recovers any pending row.
- ~~**Admin basic-auth crashes on malformed secret**~~ — `src/routes/admin.ts`. `atob` wrapped in try/catch; non-base64 or missing `:` returns `503 admin misconfigured`.
- ~~**Command parser has no item cap**~~ — `src/command/parser.ts` + `src/command/apply.ts`. `MAX_ITEMS_PER_COMMAND = 20`; surplus is dropped and the reply notes it via `（已忽略超過 N 個的部分）`.
- ~~**Dispatcher retries on permanent failures**~~ — `src/jobs/dispatcher.ts` + `src/errors.ts`. Telegram 4xx (other than 429) throws `PermanentChannelError`; the dispatcher acks those and only retries on 429/5xx/network.
- ~~**Queue type cast in entry point**~~ — `src/index.ts`. `if/else if` replaced by `switch` with `default: throw` so an unrouted queue surfaces in `wrangler tail` instead of being silently consumed.
- ~~**`noUncheckedIndexedAccess` is off**~~ — `tsconfig.json`. Flag is on; call sites adjusted (`src/jobs/checker.ts`, `src/command/parser.ts`, `src/crawler/ptt.ts`).
- ~~**HTML parser silently drops malformed entries**~~ — `src/crawler/ptt.ts`. Aggregate per-call `console.warn` reports miss counts and up to 3 sample snippets when `<r-ent>` blocks were seen but not parsed.
