import { InlineKeyboard } from 'grammy';

export const actionsList = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('Add repository', 'addRepo')
    .text('Subscriptions', 'editRepos')
    .text('Get releases', 'getReleases');

export const adminActionsList = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('Send message', 'sendMessage').text('Stats', 'getStats').row()
    .text('Force check', 'forceCheck').text('Repos', 'getRepoStats').row()
    .text('Refresh data', 'refreshData');

export const backToAdminActions = (): InlineKeyboard =>
  new InlineKeyboard().text('Back', 'adminActionsList');

export const backToActions = (): InlineKeyboard =>
  new InlineKeyboard().text('Back', 'actionsList');

export const addOneMoreRepo = (): InlineKeyboard =>
  new InlineKeyboard().text('Yes', 'addRepo').text('Nope', 'actionsList');

export const expandButton = (repoId: number, releaseId: number): InlineKeyboard =>
  new InlineKeyboard().text('Expand', `getReleases:expand:${repoId}/${releaseId}`);

export const allOrOneRepo = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('All subscriptions', 'getReleases:all')
    .text('One repository', 'getReleases:one').row()
    .text('Back', 'actionsList');

export const table = (backActionName: string, actionName: string, items: Array<{ label: string; id: number }>): InlineKeyboard => {
  const kb = new InlineKeyboard();
  items.forEach(({ label, id }) => kb.text(label, `${actionName}:${id}`).row());
  kb.text('Back', backActionName);
  return kb;
};
