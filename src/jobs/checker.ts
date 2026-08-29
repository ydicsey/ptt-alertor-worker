import type { Env, ArticleEvent } from '../env';
import { fetchBoardIndex } from '../crawler/ptt';

const PER_BOARD_DELAY_MS = 250;
const PER_BOARD_DELAY_OFF_PEAK_MS = 500;

export async function runChecker(env: Env): Promise<void> {
  const boards = await loadBoards(env);
  const offPeak = isOffPeakCST(new Date());
  const delay = offPeak ? PER_BOARD_DELAY_OFF_PEAK_MS : PER_BOARD_DELAY_MS;

  for (const { name } of boards) {
    try {
      await checkBoard(env, name);
    } catch (err) {
      console.error(`checker: board=${name}`, err);
    }
    await sleep(delay);
  }
}

interface PendingRow {
  id: string;
  board: string;
  title: string;
  author: string;
  url: string;
}

async function checkBoard(env: Env, board: string): Promise<void> {
  const articles = await fetchBoardIndex(env, board);

  // Recovery: rows from prior runs that landed in D1 but never made it onto
  // ARTICLE_QUEUE (worker killed between db.batch and queue.sendBatch).
  const pending = await env.DB.prepare(
    `SELECT id, board, title, author, url FROM articles
     WHERE board = ? AND enqueued_at IS NULL`,
  ).bind(board).all<PendingRow>();

  const toEnqueue: PendingRow[] = [...pending.results];

  if (articles.length > 0) {
    const ids = articles.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');
    const existing = await env.DB.prepare(
      `SELECT id FROM articles WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string }>();
    const known = new Set(existing.results.map((r) => r.id));

    const fresh = articles.filter((a) => !known.has(a.id));
    const head = fresh[0];
    if (head) {
      const now = Date.now();
      // Insert with enqueued_at = NULL; we mark it after sendBatch resolves so
      // a crash in between leaves a row the next sweep can recover.
      const inserts = fresh.map((a) =>
        env.DB.prepare(
          `INSERT INTO articles (id, board, title, author, url, push_count, created_at, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).bind(a.id, a.board, a.title, a.author, a.url, a.pushCount, now),
      );
      await env.DB.batch(inserts);

      await env.DB.prepare(
        `UPDATE boards SET last_article_id = ?, last_checked_at = ? WHERE name = ?`,
      ).bind(head.id, now, board).run();

      for (const a of fresh) {
        toEnqueue.push({
          id: a.id,
          board: a.board,
          title: a.title,
          author: a.author,
          url: a.url,
        });
      }
    }
  }

  if (toEnqueue.length === 0) return;

  await env.ARTICLE_QUEUE.sendBatch(
    toEnqueue.map((a) => ({
      body: {
        type: 'new_article' as const,
        board: a.board,
        articleId: a.id,
        title: a.title,
        author: a.author,
        url: a.url,
      } satisfies ArticleEvent,
    })),
  );

  const enqueuedAt = Date.now();
  const enqueuedIds = toEnqueue.map((a) => a.id);
  const ph = enqueuedIds.map(() => '?').join(',');
  await env.DB.prepare(
    `UPDATE articles SET enqueued_at = ? WHERE id IN (${ph})`,
  ).bind(enqueuedAt, ...enqueuedIds).run();
}

async function loadBoards(env: Env): Promise<{ name: string }[]> {
  const res = await env.DB.prepare(
    `SELECT name
     FROM boards
     WHERE EXISTS (
       SELECT 1 FROM keyword_subs
       WHERE keyword_subs.board = boards.name
     )
     OR EXISTS (
       SELECT 1 FROM author_subs
       WHERE author_subs.board = boards.name
     )
     ORDER BY name`,
  ).all<{ name: string }>();

  return res.results;
}

function isOffPeakCST(d: Date): boolean {
  const cstHour = (d.getUTCHours() + 8) % 24;
  return cstHour >= 3 && cstHour < 7;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
