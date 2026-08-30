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

  const matchSummary = formatMatchSummary(
    payload.matchReasons,
  );

  const firstLine = [
    `<b>[${esc(payload.board)}]</b>`,
    matchSummary,
  ]
    .filter(Boolean)
    .join(' ');

  return [
    firstLine,
    esc(payload.title),
    `— ${esc(payload.author)}`,
    esc(payload.url),
  ].join('\n');
}

function formatMatchSummary(
  reasons: string[],
): string {
  const keywords: string[] = [];
  const authors: string[] = [];
  const others: string[] = [];

  for (const reason of reasons) {
    if (reason.startsWith('keyword:')) {
      keywords.push(reason.slice(8));
      continue;
    }

    if (reason.startsWith('author:')) {
      authors.push(reason.slice(7));
      continue;
    }

    others.push(reason);
  }

  const parts: string[] = [];

  if (keywords.length > 0) {
    parts.push(
      `🔎 ${keywords.map(esc).join('・')}`,
    );
  }

  if (authors.length > 0) {
    parts.push(
      `👤 ${authors.map(esc).join('・')}`,
    );
  }

  if (others.length > 0) {
    parts.push(
      `🎯 ${others.map(esc).join('・')}`,
    );
  }

  return parts.join(' ');
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
