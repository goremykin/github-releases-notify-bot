import type { Context } from 'grammy';
import type { Chat } from 'grammy/types';
import convert from 'telegramify-markdown';
import type { Release, RepoDocument, RepoIdentifier, TelegramUser } from './types.ts';

const MAX_MESSAGE_LENGTH = 4096;
export const TRUNCATED_SUFFIX = '\n\n_\\.\\.\\.message truncated_';

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
  convert(
    `**${repo.owner}/${repo.name}**\n` +
    `${release.isPrerelease ? '**Pre-release** ' : ''}[${release.name ?? ''}](${release.url ?? ''})\n` +
    (release.description?.trim() ?? ''),
    'escape'
  );

export const truncateMessage = (message: string, maxLength: number): string => {
  if (message.length <= maxLength) return message;

  const limit = maxLength - TRUNCATED_SUFFIX.length;
  let insideCode = false;
  let lastSafeNewline = -1;

  for (let i = 0; i < limit; i++) {
    if (message.startsWith('```', i)) {
      insideCode = !insideCode;
      i += 2;
      continue;
    }
    if (!insideCode && message[i] === '\n') {
      lastSafeNewline = i;
    }
  }

  const cutAt = lastSafeNewline > 0 ? lastSafeNewline : limit;
  return message.slice(0, cutAt) + TRUNCATED_SUFFIX;
};

export const getReleaseMessages = (repo: RepoIdentifier, release: Partial<Release>): { short: string; full: string } => ({
  short: getShortReleaseMessage(repo, release),
  full: truncateMessage(getFullReleaseMessage(repo, release), MAX_MESSAGE_LENGTH),
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
