import { InlineKeyboard } from 'grammy';

export const actionsList = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('Add repository', 'addRepo')
    .text('Subscriptions', 'editRepos')
    .text('Get releases', 'getReleases');

export const adminActionsList = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('Send message', 'sendMessage')
    .text('Stats', 'getStats')
    .text('Force check', 'forceCheck');

export const backToAdminActions = (): InlineKeyboard =>
  new InlineKeyboard().text('Back', 'adminActionsList');

export const backToActions = (): InlineKeyboard =>
  new InlineKeyboard().text('Back', 'actionsList');

export const addOneMoreRepo = (): InlineKeyboard =>
  new InlineKeyboard().text('Yes', 'addRepo').text('Nope', 'actionsList');

export const expandButton = (owner: string, repoName: string, releaseName: string): InlineKeyboard =>
  new InlineKeyboard().text('Expand', `getReleases:expand:${owner}/${repoName}/${releaseName}`);

export const allOrOneRepo = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('All subscriptions', 'getReleases:all')
    .text('One repository', 'getReleases:one').row()
    .text('Back', 'actionsList');

export const table = (backActionName: string, actionName: string, items: string[]): InlineKeyboard => {
  const kb = new InlineKeyboard();
  items.forEach((item, index) => kb.text(item, `${actionName}:${index}`).row());
  kb.text('Back', backActionName);
  return kb;
};
