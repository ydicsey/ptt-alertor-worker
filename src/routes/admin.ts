import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import type { Env } from '../env';
import { setMyCommands, setWebhook } from '../telegram/api';

export const admin = new Hono<{ Bindings: Env }>();

admin.use('*', async (c, next) => {
const expected = c.env.ADMIN_BASIC_AUTH?.trim();
if (!expected) return c.text('admin disabled', 503);
  
  // Prefer a raw "user:pass" secret. Keep Base64 support for compatibility
  // with existing deployments.
  let decoded = expected;
  
  if (!expected.includes(':')) {
    try {
      decoded = atob(expected);
    } catch {
      return c.text(
        'admin misconfigured: expected "user:pass" or base64 of "user:pass"',
        503,
      );
    }
  }
  
  const idx = decoded.indexOf(':');
  if (idx < 0) return c.text('admin misconfigured: expected base64 of "user:pass"', 503);
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  return basicAuth({ username, password })(c, next);
});

admin.get('/users', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, created_at, enabled FROM users ORDER BY created_at DESC`,
  ).all();
  return c.json(res.results);
});

admin.get('/boards', async (c) => {
  const res = await c.env.DB.prepare(`SELECT * FROM boards ORDER BY name`).all();
  return c.json(res.results);
});

admin.post('/boards', async (c) => {
  const { name, isHighTraffic } = await c.req.json<{ name: string; isHighTraffic?: boolean }>();
  if (!name) return c.text('missing name', 400);
  await c.env.DB.prepare(
    `INSERT INTO boards (name, last_checked_at, is_high_traffic) VALUES (?, 0, ?)
     ON CONFLICT(name) DO UPDATE SET is_high_traffic = excluded.is_high_traffic`,
  ).bind(name, isHighTraffic ? 1 : 0).run();
  return c.json({ ok: true });
});

admin.delete('/boards/:name', async (c) => {
  await c.env.DB.prepare(`DELETE FROM boards WHERE name = ?`).bind(c.req.param('name')).run();
  return c.json({ ok: true });
});

// One-time Telegram wiring: registers the slash-command menu and points the
// bot's webhook at this Worker (with the secret token, so the webhook stays
// fail-closed). Re-runnable; safe to call again after a redeploy.
admin.post('/telegram/setup', async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return c.text('TELEGRAM_WEBHOOK_SECRET not configured', 503);

  const webhookUrl = `${new URL(c.req.url).origin}/webhooks/telegram`;
  await setMyCommands(c.env, [
    { command: 'add', description: '訂閱關鍵字（可直接帶 板名 關鍵字）' },
    { command: 'del', description: '取消關鍵字' },
    { command: 'addauthor', description: '訂閱作者' },
    { command: 'delauthor', description: '取消作者' },
    { command: 'list', description: '顯示目前訂閱' },
    { command: 'help', description: '顯示用法說明' },
  ]);
  await setWebhook(c.env, webhookUrl, secret);
  return c.json({ ok: true, webhook: webhookUrl });
});
