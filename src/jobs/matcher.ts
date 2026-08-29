import type { Env, ArticleEvent, DispatchEvent, Channel } from '../env';

interface BindingRow {
  user_id: string;
  channel: Channel;
  external_id: string;
}

export async function handleArticleBatch(
  batch: MessageBatch<ArticleEvent>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const matches = await findMatches(env, msg.body);
      // Enqueue first; ack only after the downstream queue accepted the matches.
      // Otherwise a failed sendBatch silently drops notifications.
      for (let i = 0; i < matches.length; i += 100) {
        await env.DISPATCH_QUEUE.sendBatch(
          matches.slice(i, i + 100).map((m) => ({ body: m })),
        );
      }
      msg.ack();
    } catch (err) {
      console.error('matcher error', {
        board: msg.body.board,
        articleId: msg.body.articleId,
        err,
      });
      msg.retry();
    }
  }
}

async function findMatches(env: Env, evt: ArticleEvent): Promise<DispatchEvent[]> {
  const matches = new Map<
    string,
    {
      binding: BindingRow;
      reasons: Set<string>;
    }
  >();

  const addMatch = (binding: BindingRow, reason: string) => {
    // One notification per user + delivery channel + destination.
    const key = JSON.stringify([
      binding.user_id,
      binding.channel,
      binding.external_id,
    ]);

    let entry = matches.get(key);
    if (!entry) {
      entry = {
        binding,
        reasons: new Set<string>(),
      };
      matches.set(key, entry);
    }

    entry.reasons.add(reason);
  };

  const kwRows = await env.DB.prepare(
    `SELECT ks.user_id, ks.keyword, cb.channel, cb.external_id
     FROM keyword_subs ks
     JOIN channel_bindings cb ON cb.user_id = ks.user_id
     JOIN users u ON u.id = ks.user_id
     WHERE ks.board = ? AND u.enabled = 1`,
  ).bind(evt.board).all<BindingRow & { keyword: string }>();

  const titleLower = evt.title.toLowerCase();

  for (const r of kwRows.results) {
    if (matchesKeyword(titleLower, r.keyword)) {
      addMatch(r, `keyword:${r.keyword}`);
    }
  }

  const auRows = await env.DB.prepare(
    `SELECT a.user_id, cb.channel, cb.external_id
     FROM author_subs a
     JOIN channel_bindings cb ON cb.user_id = a.user_id
     JOIN users u ON u.id = a.user_id
     WHERE a.board = ? AND a.author = ? AND u.enabled = 1`,
  ).bind(evt.board, evt.author).all<BindingRow>();

  for (const r of auRows.results) {
    addMatch(r, `author:${evt.author}`);
  }

  return Array.from(matches.values()).map(({ binding, reasons }) =>
    toDispatch(binding, evt, Array.from(reasons)),
  );
}
// A keyword may carry space-separated AND terms ("台積電 漲停"): every term must
// appear in the (already lower-cased) title to count as a match. Multiple
// keywords on the same board are independent rows, so they act as OR. The
// common single-term keyword reduces to a plain substring check.
export function matchesKeyword(titleLower: string, keyword: string): boolean {
  const terms = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => titleLower.includes(term));
}

function toDispatch(
  r: BindingRow,
  evt: ArticleEvent,
  reasons: string[],
): DispatchEvent {
  return {
    type: 'notify',
    userId: r.user_id,
    channel: r.channel,
    externalId: r.external_id,
    payload: {
      board: evt.board,
      articleId: evt.articleId,
      title: evt.title,
      author: evt.author,
      url: evt.url,
      matchReasons: reasons,
    },
  };
}
