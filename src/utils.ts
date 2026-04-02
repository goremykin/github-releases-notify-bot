import type { Context } from 'grammy';
import type { Chat } from 'grammy/types';
import type { Release, RepoDocument, RepoIdentifier, TelegramUser } from './types.ts';

const MAX_MESSAGE_LENGTH = 4096;

const chatToUser = (chat: Chat): TelegramUser => ({
  id: chat.id,
  type: chat.type,
  username: 'username' in chat ? chat.username : undefined,
  title: 'title' in chat ? chat.title : undefined,
  first_name: 'first_name' in chat ? (chat as { first_name?: string }).first_name : undefined,
  last_name: 'last_name' in chat ? (chat as { last_name?: string }).last_name : undefined,
});

export const getUser = (ctx: Context): TelegramUser => {
  const chat = ctx.chat ?? ctx.callbackQuery?.message?.chat;
  if (!chat) throw new Error('Cannot determine chat from context');
  return { ...chatToUser(chat), is_bot: ctx.from?.is_bot };
};

const getShortReleaseMessage = (
  repo: RepoIdentifier = { owner: '', name: '' },
  release: Partial<Release> = { name: '' }
): string =>
  `<b>${repo.owner}/${repo.name}</b>
${release.isPrerelease ? '<b>Pre-release</b> ' : ''}${release.name}`;

const getFullReleaseMessage = (
  repo: RepoIdentifier = { owner: '', name: '' },
  release: Partial<Release> = { name: '', url: '' }
): string =>
  `*${repo.owner}/${repo.name}*
${release.isPrerelease ? '*Pre-release* ' : ''}[${release.name}](${release.url})
${release.description
    ? release.description
      .replace(/\*/mgi, '')
      .replace(/_/mgi, '\\_')
      .trim()
    : ''}`;

const splitLongMessage = (message: string, maxLength: number): string[] => {
  const splitRegExp = new RegExp([
    `([\\s\\S]{1,${maxLength - 1}}([\\n\\r]|$))`,
    `([\\s\\S]{1,${maxLength - 1}}(\\s|$))`,
    `([\\s\\S]{1,${maxLength}})`
  ].join('|'));

  const splitedMessage: string[] = [];
  let separableString = message;

  while (separableString.length) {
    const match = separableString.match(splitRegExp);

    if (match) {
      splitedMessage.push(match[0]);
      separableString = separableString.substring(match[0].length);
    }
  }

  return splitedMessage;
};

export const getReleaseMessages = (repo: RepoIdentifier, release: Partial<Release>): { short: string; full: string[] } => ({
  short: getShortReleaseMessage(repo, release),
  full: splitLongMessage(getFullReleaseMessage(repo, release), MAX_MESSAGE_LENGTH)
});

export const parseRepo = (str: string): RepoIdentifier | null => {
  const githubRegexp = /(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)/i;
  let owner: string | undefined, name: string | undefined;

  try {
    if (str && typeof str === 'string') {
      const match = str.match(githubRegexp);

      if (match) {
        [, owner, name] = match;
      } else {
        [owner, name] = str.replace(' ', '').split('/');
      }
    }

    if (owner && name) {
      return { owner, name };
    } else {
      return null;
    }
  } catch {
    return null;
  }
};

export const getLastReleasesInRepos = (repo: RepoDocument): RepoDocument => {
  const last = repo.releases[0];
  const lastRelease = repo.releases.find((release) => !release.isPrerelease);
  const releases = last ? [last] : [];

  if (last && last.isPrerelease && lastRelease) {
    releases.unshift(lastRelease);
  }

  return { ...repo, releases };
};
