import Telegraf from 'telegraf';

const { Markup } = Telegraf as { Markup: {
  inlineKeyboard: (buttons: unknown[]) => { extra: () => unknown };
  callbackButton: (text: string, action: string) => unknown;
  urlButton: (text: string, url: string) => unknown;
} };

export const actionsList = () => Markup.inlineKeyboard([
  Markup.callbackButton('Add repository', 'addRepo'),
  Markup.callbackButton('Subscriptions', 'editRepos'),
  Markup.callbackButton('Get releases', 'getReleases')
]).extra();

export const adminActionsList = () => Markup.inlineKeyboard([
  [
    Markup.callbackButton('Send message', 'sendMessage'),
    Markup.callbackButton('Stats', 'getStats'),
    Markup.callbackButton('Force check', 'forceCheck'),
  ],
  [
    Markup.callbackButton('DB Export', 'dbExport'),
    Markup.callbackButton('DB Import', 'dbImport'),
    Markup.callbackButton('DB Verify', 'dbVerify'),
  ]
]).extra();

export const backToAdminActions = () => Markup.inlineKeyboard([
  Markup.callbackButton('Back', 'adminActionsList')
]).extra();

export const backToActions = () => Markup.inlineKeyboard([
  Markup.callbackButton('Back', 'actionsList')
]).extra();

export const addOneMoreRepo = () => Markup.inlineKeyboard([
  Markup.callbackButton('Yes', 'addRepo'),
  Markup.callbackButton('Nope', 'actionsList')
]).extra();

export const expandButton = (data: number) => Markup.inlineKeyboard([
  Markup.callbackButton('Expand', `getReleases:expand:${data}`)
]).extra();

export const allOrOneRepo = () => Markup.inlineKeyboard([
  [
    Markup.callbackButton('All subscriptions', 'getReleases:all'),
    Markup.callbackButton('One repository', 'getReleases:one')
  ],
  [Markup.callbackButton('Back', 'actionsList')]
]).extra();

export const table = (backActionName: string, actionName: string, items: string[]) =>
  Markup.inlineKeyboard([
    ...items.map((item, index) => [Markup.callbackButton(item, `${actionName}:${index}`)]),
    [Markup.callbackButton('Back', backActionName)]
  ]).extra();

export const paginationTable = (backActionName: string, actionName: string, items: string[]) =>
  Markup.inlineKeyboard([
    ...items.map((item, index) => [Markup.callbackButton(item, `${actionName}:${index}`)]),
    [Markup.callbackButton('prev', ''), Markup.callbackButton('next', '')],
    [Markup.callbackButton('Back', backActionName)]
  ]).extra();
