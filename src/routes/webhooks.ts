import { Hono } from 'hono';
import type { Env } from '../env';
import {
  parseCommand,
  parseGuideCallback,
  parseRemoveCallback,
  buildGuideCallback,
  buildRemoveCallback,
  detectGuidedMode,
  parseGuidedReply,
  guidePromptTitle,
  buildMainMenuCallback,
  parseMainMenuCallback,
  type GuideAction,
  type GuideTarget,
} from '../command/parser';
import {
  ensureUserAndBinding,
  applyCommand,
  listKeywordSubs,
  listAuthorSubs,
  deleteKeywordSubByRowid,
  deleteAuthorSubByRowid,
  formatList,
  helpText,
  type SubRow,
} from '../command/apply';
import {
  sendMessage,
  deleteMessages,
  answerCallbackQuery,
  editMessageText,
} from '../telegram/api';
import type { InlineButton } from '../telegram/api';

// Telegram caps inline keyboards (~100 buttons); keep the removal menu well
// under that. A user with more subs than this can delete in waves or by text.
const REMOVE_MENU_MAX = 50;
const UI_TIMEOUT_SECONDS = 60;

function isTelegramUserAllowed(env: Env, userId: number | undefined): boolean {
  if (userId === undefined || !env.TELEGRAM_ALLOWED_USER_IDS) {
    return false;
  }

  const allowedIds = env.TELEGRAM_ALLOWED_USER_IDS
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return allowedIds.includes(String(userId));
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number };
  text?: string;
  from?: { id: number; username?: string };

  reply_to_message?: {
    message_id: number;
    date: number;
    text?: string;
  };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
  from: { id: number };
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post('/telegram', async (c) => {
  // Fail closed: webhook is unauthenticated unless a secret is configured AND matches
  // the X-Telegram-Bot-Api-Secret-Token header set via setWebhook(secret_token=...).
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return c.text('webhook not configured', 503);
  }
  const got = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (got !== expected) {
    return c.text('forbidden', 403);
  }

  const update = await c.req.json<TelegramUpdate>();

  const telegramUserId =
  update.callback_query?.from.id ??
  update.message?.from?.id;

  if (!isTelegramUserAllowed(c.env, telegramUserId)) {
    console.warn('Blocked unauthorized Telegram user', telegramUserId);
    return c.json({ ok: true });
  }

  if (update.callback_query) {
    await handleCallback(c.env, update.callback_query);
    return c.json({ ok: true });
  }

  const msg = update.message;
  if (!msg?.text) return c.json({ ok: true });

  const chatId = String(msg.chat.id);
  const userId = await ensureUserAndBinding(c.env, 'telegram', chatId);

  // Guided two-step flow, step 2: the user replied to one of our force_reply
  // prompts. The mode (subscribe/unsubscribe × keyword/author) is recovered
  // from the prompt text — no server-side conversation state.
  const prompt = msg.reply_to_message;
  const promptText = prompt?.text;
  const mode = promptText
    ? detectGuidedMode(promptText)
    : null;
  
  if (mode && prompt) {
    const ageSeconds =
      msg.date - prompt.date;
  
    // The operation is valid only for 60 seconds from when
    // the bot created the force-reply prompt.
    if (ageSeconds > UI_TIMEOUT_SECONDS) {
      const expired = await sendMessage(
        c.env,
        chatId,
        '⌛ 操作已逾時，請重新操作。',
      );
  
      // Remove both the old prompt and the late reply.
      await deleteUiMessagesBestEffort(
        c.env,
        chatId,
        [
          prompt.message_id,
          msg.message_id,
        ],
      );
  
      // The timeout notice itself is temporary.
      await scheduleUiCleanup(
        c.env,
        chatId,
        [expired.message_id],
        8,
      );
  
      return c.json({ ok: true });
    }
  
    const cmd = parseGuidedReply(
      mode.action,
      mode.target,
      msg.text,
    );
  
    const reply = await applyCommand(
      c.env,
      userId,
      cmd,
    );
  
    // Send the final result first. This is the message we keep.
    await sendMessage(
      c.env,
      chatId,
      reply,
    );
  
    // Then remove the temporary conversation:
    //   1. bot prompt
    //   2. user's reply
    await deleteUiMessagesBestEffort(
      c.env,
      chatId,
      [
        prompt.message_id,
        msg.message_id,
      ],
    );
  
    return c.json({ ok: true });
  }

  const cmd = parseCommand(msg.text);
  if (cmd.kind === 'help') {
    await renderMainMenu(c.env, chatId);
    return c.json({ ok: true });
  }
  if (cmd.kind === 'guide') {
    await startGuide(c.env, chatId, cmd.action, cmd.target);
    return c.json({ ok: true });
  }
  if (cmd.kind === 'remove_menu') {
    await renderRemoveMenu(c.env, chatId, userId, cmd.target);
    return c.json({ ok: true });
  }

  const reply = await applyCommand(c.env, userId, cmd);
  await sendMessage(c.env, chatId, reply);
  return c.json({ ok: true });
});

async function renderMainMenu(
  env: Env,
  chatId: string,
): Promise<void> {
  await sendMessage(
    env,
    chatId,
    [
      '🔔 PTT Alertor',
      '',
      '追蹤 PTT 新文章，',
      '符合訂閱條件時自動通知你。',
      '',
      '請選擇一個操作 👇',
    ].join('\n'),
    {
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: '➕ 新增關鍵字',
              callback_data: buildMainMenuCallback('add_keyword'),
            },
            {
              text: '👤 新增作者',
              callback_data: buildMainMenuCallback('add_author'),
            },
          ],
          [
            {
              text: '📋 我的訂閱',
              callback_data: buildMainMenuCallback('list'),
            },
            {
              text: '🗑 管理訂閱',
              callback_data: buildMainMenuCallback('manage'),
            },
          ],
          [
            {
              text: '📖 使用說明',
              callback_data: buildMainMenuCallback('help'),
            },
          ],
        ],
      },
    },
  );
}

// Guided subscribe flow, step 1: a bare /add or /addauthor. With no target yet,
// offer the type as inline buttons; with a target known (/addauthor), jump
// straight to the force_reply prompt.
async function startGuide(
  env: Env,
  chatId: string,
  action: GuideAction,
  target?: GuideTarget,
): Promise<void> {
  if (!target) {
    const verb = action === 'subscribe' ? '訂閱' : '取消訂閱';
    await sendMessage(env, chatId, `要${verb}什麼？`, {
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '關鍵字', callback_data: buildGuideCallback(action, 'keyword') },
            { text: '作者', callback_data: buildGuideCallback(action, 'author') },
          ],
        ],
      },
    });
    return;
  }
  await sendForceReplyPrompt(env, chatId, action, target);
}

async function deleteUiMessagesBestEffort(
  env: Env,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  try {
    await deleteMessages(
      env,
      chatId,
      messageIds,
    );
  } catch (err) {
    // UI cleanup failure must never make Telegram retry the whole webhook,
    // because the subscription/database operation may already have succeeded.
    console.warn(
      'telegram UI immediate cleanup failed',
      err,
    );
  }
}

async function scheduleUiCleanup(
  env: Env,
  chatId: string,
  messageIds: number[],
  delaySeconds = UI_TIMEOUT_SECONDS,
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  await env.UI_CLEANUP_QUEUE.send(
    {
      type: 'telegram_cleanup',
      chatId,
      messageIds,
    },
    {
      delaySeconds,
    },
  );
}

async function sendForceReplyPrompt(
  env: Env,
  chatId: string,
  action: GuideAction,
  target: GuideTarget,
): Promise<void> {
  const title = guidePromptTitle(action, target);
  const itemWord =
    target === 'keyword' ? '關鍵字' : '作者 ID';

  const example =
    target === 'keyword'
      ? 'Stock 台積電'
      : 'Stock someuser';

  const text = [
    title,
    `請在 ${UI_TIMEOUT_SECONDS} 秒內回覆：`,
    `<板名> <${itemWord}>`,
    `例如：${example}`,
  ].join('\n');

  const sent = await sendMessage(
    env,
    chatId,
    text,
    {
      replyMarkup: {
        force_reply: true,
        input_field_placeholder: example,
      },
    },
  );

  await scheduleUiCleanup(
    env,
    chatId,
    [sent.message_id],
  );
}

// --- Tap-to-delete removal menu -------------------------------------------

function listSubs(env: Env, userId: string, target: GuideTarget): Promise<SubRow[]> {
  return target === 'keyword' ? listKeywordSubs(env, userId) : listAuthorSubs(env, userId);
}

function removeMenuTitle(target: GuideTarget, total: number): string {
  const word = target === 'keyword' ? '關鍵字' : '作者';
  const more = total > REMOVE_MENU_MAX ? `（前 ${REMOVE_MENU_MAX} 筆）` : '';
  return `點選要刪除的${word}：${more}`;
}

function buildRemoveKeyboard(target: GuideTarget, subs: SubRow[]): InlineButton[][] {
  return subs.slice(0, REMOVE_MENU_MAX).map((s) => [
    { text: `${s.board}: ${s.value}`, callback_data: buildRemoveCallback(target, s.rowid) },
  ]);
}

// Sends a fresh removal menu in response to a bare /del or /delauthor.
async function renderRemoveMenu(
  env: Env,
  chatId: string,
  userId: string,
  target: GuideTarget,
): Promise<void> {
  const subs = await listSubs(env, userId, target);
  if (subs.length === 0) {
    const word = target === 'keyword' ? '關鍵字' : '作者';
    await sendMessage(env, chatId, `目前沒有${word}訂閱可刪除。`);
    return;
  }
  await sendMessage(env, chatId, removeMenuTitle(target, subs.length), {
    replyMarkup: { inline_keyboard: buildRemoveKeyboard(target, subs) },
  });
}

// Re-renders the removal menu in place after a delete, dropping the tapped row.
async function rerenderRemoveMenu(
  env: Env,
  chatId: string,
  messageId: number,
  userId: string,
  target: GuideTarget,
): Promise<void> {
  const subs = await listSubs(env, userId, target);
  if (subs.length === 0) {
    const word = target === 'keyword' ? '關鍵字' : '作者';
    await editMessageText(env, chatId, messageId, `（已無${word}訂閱）`);
    return;
  }
  await editMessageText(env, chatId, messageId, removeMenuTitle(target, subs.length), {
    inline_keyboard: buildRemoveKeyboard(target, subs),
  });
}

async function answerToast(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  // Answering clears the client spinner. A stale/expired callback answers with
  // 400; don't let that fail the webhook (Telegram would redeliver the dead
  // callback) — log and carry on.
  try {
    await answerCallbackQuery(env, callbackQueryId, text);
  } catch (err) {
    console.warn('answerCallbackQuery failed', err);
  }
}

async function handleCallback(env: Env, cq: TelegramCallbackQuery): Promise<void> {
  const chatId = cq.message ? String(cq.message.chat.id) : String(cq.from.id);
  const data = cq.data;

  const mainMenu = data ? parseMainMenuCallback(data) : null;

  if (mainMenu) {
    await answerToast(env, cq.id);
  
    switch (mainMenu) {
      case 'add_keyword':
        await sendForceReplyPrompt(
          env,
          chatId,
          'subscribe',
          'keyword',
        );
        return;
  
      case 'add_author':
        await sendForceReplyPrompt(
          env,
          chatId,
          'subscribe',
          'author',
        );
        return;
  
      case 'list': {
        const userId = await ensureUserAndBinding(
          env,
          'telegram',
          chatId,
        );
  
        const text = await formatList(env, userId);
        await sendMessage(env, chatId, text);
        return;
      }
  
      case 'manage':
        await startGuide(env, chatId, 'unsubscribe');
        return;
  
      case 'help':
        await sendMessage(env, chatId, helpText());
        return;
    }
  }
  
  // Tap-to-delete from the removal menu.
  const removal = data ? parseRemoveCallback(data) : null;
  if (removal) {
    const userId = await ensureUserAndBinding(env, 'telegram', chatId);
    const deleted =
      removal.target === 'keyword'
        ? await deleteKeywordSubByRowid(env, userId, removal.rowid)
        : await deleteAuthorSubByRowid(env, userId, removal.rowid);
    await answerToast(
      env,
      cq.id,
      deleted ? `已取消 ${deleted.board}:${deleted.value}` : '已刪除或不存在',
    );
    if (cq.message) {
      await rerenderRemoveMenu(env, chatId, cq.message.message_id, userId, removal.target);
    }
    return;
  }

  // Guided subscribe type picker.
  await answerToast(env, cq.id);
  const guide = data ? parseGuideCallback(data) : null;
  if (!guide) return;
  await sendForceReplyPrompt(env, chatId, guide.action, guide.target);
}

webhooks.post('/line', async (c) => {
  return c.json({ ok: true });
});

webhooks.get('/messenger', (c) => {
  const challenge = c.req.query('hub.challenge');
  return c.text(challenge ?? '', 200);
});

webhooks.post('/messenger', async (c) => {
  return c.json({ ok: true });
});
