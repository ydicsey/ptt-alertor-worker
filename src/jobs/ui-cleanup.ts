import type { Env, UiCleanupEvent } from '../env';
import { deleteMessages } from '../telegram/api';
import { PermanentChannelError } from '../errors';

export async function handleUiCleanupBatch(
  batch: MessageBatch<UiCleanupEvent>,
  env: Env,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (msg) => {
      const evt = msg.body;

      // Malformed/empty cleanup events should not be retried forever.
      if (
        evt.type !== 'telegram_cleanup' ||
        !evt.chatId ||
        !Array.isArray(evt.messageIds) ||
        evt.messageIds.length === 0
      ) {
        console.warn('ui cleanup: invalid event');
        msg.ack();
        return;
      }

      try {
        await deleteMessages(
          env,
          evt.chatId,
          evt.messageIds,
        );

        msg.ack();
      } catch (err) {
        if (err instanceof PermanentChannelError) {
          // This is expected when the message was already deleted earlier,
          // e.g. an operation completed successfully before the 60s cleanup.
          console.warn('ui cleanup: permanent delete failure', {
            status: err.status,
            messageCount: evt.messageIds.length,
          });

          msg.ack();
          return;
        }

        console.error('ui cleanup: transient failure', err);

        msg.retry({
          delaySeconds: 30,
        });
      }
    }),
  );
}
