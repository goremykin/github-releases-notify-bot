import type { Release, RepoDocument, RepoIdentifier, TelegramUser } from './types.ts';

const MAX_MESSAGE_LENGTH = 4096;

interface TelegramContext {
  message?: { chat: TelegramUser; from: TelegramUser };
  update?: { callback_query: { message: { chat: TelegramUser }; from: TelegramUser } };
}

export const getUser = (ctx: TelegramContext): TelegramUser =>
  ctx.message
    ? (ctx.message.chat || ctx.message.from)
    : (ctx.update!.callback_query.message.chat || ctx.update!.callback_query.from);

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
  const githubRegexp = /https?:\/\/github\.com\/(.*?)\/(.*?)\/?$/i;
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
  const revertedReleases = repo.releases.slice().reverse();

  const last = revertedReleases[0];
  const lastRelease = revertedReleases.find((release) => !release.isPrerelease);
  const releases = last ? [last] : [];

  if (last && last.isPrerelease && lastRelease) {
    releases.unshift(lastRelease);
  }

  return { ...repo, releases };
};
