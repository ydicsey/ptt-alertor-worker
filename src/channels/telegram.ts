import type { Env, DispatchEvent } from '../env';
import { sendMessage } from '../telegram/api';

export async function sendTelegram(env: Env, evt: DispatchEvent): Promise<void> {
  // Token redaction and the transient-vs-permanent (PermanentChannelError)
  // error split live in the shared client; dispatcher.ts branches on the
  // error type to decide retry vs ack.
  await sendMessage(env, evt.externalId, formatMessage(evt), { parseMode: 'HTML' });
}

function formatMessage(evt: DispatchEvent): string {
  const { payload } = evt;

  const reasons = payload.matchReasons
    .map(formatReason)
    .map((reason) => `• ${reason}`)
    .join('\n');

  return [
    `<b>[${esc(payload.board)}]</b>`,
    `符合：`,
    reasons,
    '',
    esc(payload.title),
    `— ${esc(payload.author)}`,
    esc(payload.url),
  ].join('\n');
}

function formatReason(reason: string): string {
  if (reason.startsWith('keyword:')) {
    return `關鍵字「${esc(reason.slice(8))}」`;
  }

  if (reason.startsWith('author:')) {
    return `作者「${esc(reason.slice(7))}」`;
  }

  return esc(reason);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
