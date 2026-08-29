import type { Env } from '../env';
import { PermanentChannelError } from '../errors';

// Low-level Telegram Bot API client shared by the notify channel
// (src/channels/telegram.ts) and the webhook command surface
// (src/routes/webhooks.ts). Centralises token redaction and the
// transient-vs-permanent error split so callers don't repeat it.

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { force_reply: true; input_field_placeholder?: string };

export interface SendOptions {
  replyMarkup?: ReplyMarkup;
  parseMode?: 'HTML';
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface TelegramSentMessage {
  message_id: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function callTelegram<T>(
  env: Env,
  method: string,
  body: unknown,
): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (res.ok) {
    const parsed = (await res.json()) as TelegramApiResponse<T>;
    return parsed.result;
  }

  // Telegram error bodies can echo the request URL, which contains the bot
  // token. Parse only the description and scrub any possible token leak.
  let detail = '';

  try {
    const parsed = (await res.json()) as { description?: string };
    detail = parsed.description ?? '';
  } catch {
    // Body wasn't JSON; drop it to avoid leaking URL/token information.
  }

  detail = detail.replaceAll(
    env.TELEGRAM_BOT_TOKEN,
    '<redacted>',
  );

  const message =
    `telegram ${method} ${res.status}` +
    (detail ? `: ${detail}` : '');

  // 429 is rate-limit (transient); other 4xx are normally permanent.
  if (
    res.status >= 400 &&
    res.status < 500 &&
    res.status !== 429
  ) {
    throw new PermanentChannelError(res.status, message);
  }

  throw new Error(message);
}

export async function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  opts: SendOptions = {},
): Promise<TelegramSentMessage> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (opts.parseMode) {
    body.parse_mode = opts.parseMode;
  }

  if (opts.replyMarkup) {
    body.reply_markup = opts.replyMarkup;
  }

  return callTelegram<TelegramSentMessage>(
    env,
    'sendMessage',
    body,
  );
}

export async function deleteMessage(
  env: Env,
  chatId: string,
  messageId: number,
): Promise<void> {
  await callTelegram<boolean>(
    env,
    'deleteMessage',
    {
      chat_id: chatId,
      message_id: messageId,
    },
  );
}

export async function deleteMessages(
  env: Env,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  await callTelegram<boolean>(
    env,
    'deleteMessages',
    {
      chat_id: chatId,
      message_ids: messageIds,
    },
  );
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };

  if (text) {
    body.text = text;
  }

  await callTelegram<boolean>(
    env,
    'answerCallbackQuery',
    body,
  );
}

// Edits an existing message in place — used to re-render the tap-to-delete
// menu after a removal.
export async function editMessageText(
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await callTelegram<unknown>(
    env,
    'editMessageText',
    body,
  );
}

export async function setMyCommands(
  env: Env,
  commands: BotCommand[],
): Promise<void> {
  await callTelegram<boolean>(
    env,
    'setMyCommands',
    { commands },
  );
}

export async function setWebhook(
  env: Env,
  url: string,
  secretToken: string,
): Promise<void> {
  await callTelegram<boolean>(
    env,
    'setWebhook',
    {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    },
  );
}
