export type Channel = 'telegram' | 'line' | 'messenger' | 'mail';

export interface Env {
  DB: D1Database;
  ARTICLE_QUEUE: Queue<ArticleEvent>;
  DISPATCH_QUEUE: Queue<DispatchEvent>;

  PTT_BASE_URL: string;
  USER_AGENT: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  ADMIN_BASIC_AUTH?: string;

  LINE_CHANNEL_TOKEN?: string;
  MESSENGER_PAGE_TOKEN?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
}

export interface ArticleEvent {
  type: 'new_article';
  board: string;
  articleId: string;
  title: string;
  author: string;
  url: string;
}

export interface NotifyPayload {
  board: string;
  articleId: string;
  title: string;
  author: string;
  url: string;
  matchReason: string[];
}

export interface DispatchEvent {
  type: 'notify';
  userId: string;
  channel: Channel;
  externalId: string;
  payload: NotifyPayload;
}
