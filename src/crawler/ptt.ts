import type { Env } from '../env';

export interface ScrapedArticle {
  id: string;
  board: string;
  title: string;
  author: string;
  url: string;
  pushCount: number;
}

export async function fetchBoardIndex(env: Env, board: string): Promise<ScrapedArticle[]> {
  const url = `${env.PTT_BASE_URL}/bbs/${encodeURIComponent(board)}/index.html`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': env.USER_AGENT,
      Cookie: 'over18=1',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    throw new Error(`PTT fetch ${board} failed: ${res.status}`);
  }
  const html = await res.text();
  return parseBoardIndex(env.PTT_BASE_URL, board, html);
}

export function parseBoardIndex(baseUrl: string, board: string, html: string): ScrapedArticle[] {
  const out: ScrapedArticle[] = [];
  const reEntry = /<div class="r-ent">([\s\S]*?)<\/div>\s*<\/div>/g;
  // Deleted posts render the title as "(本文已被刪除) [id]" or
  // "(本文已被 id 刪除)" with no <a> — expected, not layout drift.
  const reDeleted = /\((?:本文)?已被[\s\S]*?刪除\)/;
  let entries = 0;
  let deleted = 0;
  const misses: Array<{ reason: string; sample: string }> = [];
  const recordMiss = (reason: string, sample: string) => {
    if (misses.length < 3) misses.push({ reason, sample: sample.slice(0, 80) });
  };

  for (const match of html.matchAll(reEntry)) {
    entries++;
    const block = match[1];
    if (!block) {
      recordMiss('empty-block', '');
      continue;
    }

    const linkMatch = block.match(/<div class="title">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!linkMatch) {
      // Deleted posts legitimately have no <a>; count them separately so they
      // don't inflate `missed` and warn on every crawl. A no-link block that
      // is NOT a deleted post is real layout drift and still recorded.
      if (reDeleted.test(block)) {
        deleted++;
      } else {
        recordMiss('no-link', block);
      }
      continue;
    }
    const href = linkMatch[1] ?? '';
    const title = decodeEntities((linkMatch[2] ?? '').trim());

    const idMatch = href.match(/\/([^/]+)\.html$/);
    if (!idMatch) {
      recordMiss('no-id', href);
      continue;
    }
    const id = idMatch[1] ?? '';

    const boardMatch = href.match(/^\/bbs\/([^/]+)\//);
    const canonicalBoard = boardMatch?.[1] ?? board;

    const authorMatch = block.match(/<div class="author">([^<]*)<\/div>/);
    const author = (authorMatch?.[1] ?? '').trim();

    const pushMatch = block.match(/<div class="nrec">[\s\S]*?<span[^>]*>([^<]*)<\/span>/);
    const pushCount = parsePushCount((pushMatch?.[1] ?? '').trim());

    out.push({
      id,
      board: canonicalBoard,
      title,
      author,
      url: `${baseUrl}${href}`,
      pushCount,
    });
  }

  // If <r-ent> blocks were found but yielded neither an article nor a known
  // deleted-post row, PTT changed its markup and articles would silently vanish
  // without this signal. Deleted posts are excluded from `missed` so routine
  // deletions don't warn on every crawl. One aggregate warning per call (instead
  // of per-entry) keeps `wrangler tail` legible.
  const missed = entries - out.length - deleted;
  if (entries > 0 && missed > 0) {
    console.warn('ptt parser misses', {
      board,
      entries,
      parsed: out.length,
      deleted,
      missed,
      misses,
    });
  } else if (entries === 0) {
    console.warn('ptt parser no entries', { board, htmlLength: html.length });
  }
  return out;
}

function parsePushCount(s: string): number {
  if (!s) return 0;
  if (s === '爆') return 100;
  if (s.startsWith('X')) {
    const n = parseInt(s.slice(1) || '1', 10);
    return -(Number.isNaN(n) ? 1 : n) * 10;
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
