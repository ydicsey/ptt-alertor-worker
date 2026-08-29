import type { Env, Channel } from '../env';
import type { Command } from './parser';
import { MAX_ITEMS_PER_COMMAND } from './parser';
import { fetchBoardIndex } from '../crawler/ptt';

export async function ensureUserAndBinding(
  env: Env,
  channel: Channel,
  externalId: string,
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT user_id FROM channel_bindings WHERE channel = ? AND external_id = ?`,
  ).bind(channel, externalId).first<{ user_id: string }>();
  if (existing) return existing.user_id;

  const userId = `${channel}:${externalId}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, created_at, enabled) VALUES (?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO channel_bindings (user_id, channel, external_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel) DO NOTHING`,
    ).bind(userId, channel, externalId),
  ]);
  return userId;
}

export async function applyCommand(env: Env, userId: string, cmd: Command): Promise<string> {
  switch (cmd.kind) {
    case 'help':
      return helpText();
    case 'list':
      return formatList(env, userId);
    case 'subscribe_keyword':
      if (cmd.items.length === 0) return '沒有可訂閱的關鍵字。';
      await ensureBoard(env, cmd.board);
      await env.DB.batch(
        cmd.items.map((k) =>
          env.DB.prepare(
            `INSERT INTO keyword_subs (user_id, board, keyword) VALUES (?, ?, ?)
             ON CONFLICT(user_id, board, keyword) DO NOTHING`,
          ).bind(userId, cmd.board, k),
        ),
      );
      return `已訂閱 ${cmd.board} 關鍵字:${cmd.items.join(', ')}${truncationNote(cmd.truncated)}`;
    case 'unsubscribe_keyword':
      if (cmd.items.length === 0) return '沒有可取消的關鍵字。';
      await env.DB.batch(
        cmd.items.map((k) =>
          env.DB.prepare(
            `DELETE FROM keyword_subs WHERE user_id = ? AND board = ? AND keyword = ?`,
          ).bind(userId, cmd.board, k),
        ),
      );
      return `已取消 ${cmd.board} 關鍵字:${cmd.items.join(', ')}${truncationNote(cmd.truncated)}`;
    case 'subscribe_author':
      if (cmd.items.length === 0) return '沒有可訂閱的作者。';
      await ensureBoard(env, cmd.board);
      await env.DB.batch(
        cmd.items.map((a) =>
          env.DB.prepare(
            `INSERT INTO author_subs (user_id, board, author) VALUES (?, ?, ?)
             ON CONFLICT(user_id, board, author) DO NOTHING`,
          ).bind(userId, cmd.board, a),
        ),
      );
      return `已訂閱 ${cmd.board} 作者:${cmd.items.join(', ')}${truncationNote(cmd.truncated)}`;
    case 'unsubscribe_author':
      if (cmd.items.length === 0) return '沒有可取消的作者。';
      await env.DB.batch(
        cmd.items.map((a) =>
          env.DB.prepare(
            `DELETE FROM author_subs WHERE user_id = ? AND board = ? AND author = ?`,
          ).bind(userId, cmd.board, a),
        ),
      );
      return `已取消 ${cmd.board} 作者:${cmd.items.join(', ')}${truncationNote(cmd.truncated)}`;
    case 'guide':
    case 'remove_menu':
      // The webhook intercepts `guide`/`remove_menu` to drive the interactive
      // button flow; reaching applyCommand means it was invoked outside that
      // path, so fall back to usage text rather than silently doing nothing.
      return helpText();
    case 'unknown':
      return '無法理解的指令。輸入 help 查看用法。';
  }
}

// A subscription row keyed by its SQLite rowid so the removal menu can delete
// it by id (ownership re-checked via user_id) regardless of keyword length.
export interface SubRow {
  rowid: number;
  board: string;
  value: string;
}

export async function listKeywordSubs(env: Env, userId: string): Promise<SubRow[]> {
  const r = await env.DB.prepare(
    `SELECT rowid AS rowid, board, keyword AS value FROM keyword_subs
     WHERE user_id = ? ORDER BY board, keyword`,
  ).bind(userId).all<SubRow>();
  return r.results;
}

export async function listAuthorSubs(env: Env, userId: string): Promise<SubRow[]> {
  const r = await env.DB.prepare(
    `SELECT rowid AS rowid, board, author AS value FROM author_subs
     WHERE user_id = ? ORDER BY board, author`,
  ).bind(userId).all<SubRow>();
  return r.results;
}

export async function deleteKeywordSubByRowid(
  env: Env,
  userId: string,
  rowid: number,
): Promise<SubRow | null> {
  const row = await env.DB.prepare(
    `DELETE FROM keyword_subs WHERE rowid = ? AND user_id = ?
     RETURNING rowid AS rowid, board, keyword AS value`,
  ).bind(rowid, userId).first<SubRow>();
  return row ?? null;
}

export async function deleteAuthorSubByRowid(
  env: Env,
  userId: string,
  rowid: number,
): Promise<SubRow | null> {
  const row = await env.DB.prepare(
    `DELETE FROM author_subs WHERE rowid = ? AND user_id = ?
     RETURNING rowid AS rowid, board, author AS value`,
  ).bind(rowid, userId).first<SubRow>();
  return row ?? null;
}

function truncationNote(truncated: boolean | undefined): string {
  return truncated ? `（已忽略超過 ${MAX_ITEMS_PER_COMMAND} 個的部分）` : '';
}

async function ensureBoard(env: Env, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO boards (name, last_checked_at) VALUES (?, 0)
     ON CONFLICT(name) DO NOTHING`,
  ).bind(name).run();
}

export async function formatList(env: Env, userId: string): Promise<string> {
  const kws = await env.DB.prepare(
    `SELECT board, keyword FROM keyword_subs WHERE user_id = ? ORDER BY board, keyword`,
  ).bind(userId).all<{ board: string; keyword: string }>();
  const aus = await env.DB.prepare(
    `SELECT board, author FROM author_subs WHERE user_id = ? ORDER BY board, author`,
  ).bind(userId).all<{ board: string; author: string }>();

  if (kws.results.length === 0 && aus.results.length === 0) return '（沒有訂閱）';

  const lines: string[] = [];
  if (kws.results.length) {
    lines.push('關鍵字:');
    for (const r of kws.results) lines.push(`  ${r.board}: ${r.keyword}`);
  }
  if (aus.results.length) {
    lines.push('作者:');
    for (const r of aus.results) lines.push(`  ${r.board}: ${r.author}`);
  }
  return lines.join('\n');
}

export function helpText(): string {
  return [
    '指令（斜線，建議）:',
    '  /add        - 引導訂閱關鍵字（按鈕選類型）',
    '  /add <板名> <關鍵字...>      - 直接訂閱關鍵字',
    '  /del        - 列出關鍵字訂閱，點按鈕刪除',
    '  /delauthor  - 列出作者訂閱，點按鈕刪除',
    '  /addauthor <板名> <ID...>   - 訂閱作者',
    '  /list       - 顯示目前訂閱',
    '  /help       - 顯示此說明',
    '',
    '關鍵字邏輯 — 逗號=或、空格=且:',
    '  /add Stock 台積電,聯電      台積電 或 聯電',
    '  /add Stock 台積電 漲停      台積電 且 漲停（同一標題都要出現）',
    '',
    '或用文字:',
    '  新增 <板名> 關鍵字 <關鍵字1>,<關鍵字2>',
    '  刪除 <板名> 作者 <ID1>,<ID2>',
    '  清單 / help',
  ].join('\n');
}
