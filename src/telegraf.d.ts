declare module 'telegraf' {
  interface InlineKeyboardButton {}
  interface InlineKeyboardMarkup {}
  interface ExtraEditMessage {}

  interface MarkupClass {
    callbackButton(text: string, action: string): InlineKeyboardButton;
    urlButton(text: string, url: string): InlineKeyboardButton;
    inlineKeyboard(buttons: unknown[]): { extra(): unknown };
  }

  interface ExtraClass {
    markdown(): { parse_mode: 'Markdown' };
  }

  interface BotInfo {
    username: string;
  }

  interface TelegramAPI {
    getMe(): Promise<BotInfo>;
    setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
    sendMessage(chatId: number | string, text: string, extra?: unknown): Promise<unknown>;
    getChatMembersCount(chatId: number | string): Promise<number>;
    getChat(chatId: number | string): Promise<unknown>;
  }

  interface BotOptions {
    username?: string;
  }

  interface TelegrafBot {
    options: BotOptions;
    telegram: TelegramAPI;
    use(middleware: unknown): void;
    catch(handler: (err: Error) => void): void;
    command(cmd: string, handler: (...args: unknown[]) => unknown): void;
    action(trigger: string | RegExp, handler: (...args: unknown[]) => unknown): void;
    hears(trigger: string | RegExp, handler: (...args: unknown[]) => unknown): void;
    startPolling(): void;
  }

  interface TelegrafConstructor {
    new(token: string, opts?: unknown): TelegrafBot;
    Markup: MarkupClass;
    Extra: ExtraClass;
    session(): unknown;
  }

  const Telegraf: TelegrafConstructor;
  export default Telegraf;
}
