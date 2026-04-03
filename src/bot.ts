import { Bot as GrammyBot, Context, session } from 'grammy';
import type { SessionFlavor, StorageAdapter } from 'grammy';
import type { ParseMode } from 'grammy/types';
import { InlineKeyboard } from 'grammy';

import * as keyboards from './keyboards.ts';
import { about, greeting, stats } from './texts.ts';
import { getUser, parseRepo, getLastReleasesInRepos, getReleaseMessages } from './utils.ts';
import { getVersions, getManyVersionsInBunches } from './github-client.ts';
import { config } from './config.ts';
import type { Db } from './db.sqlite.ts';
import type { Logger } from './logger.ts';
import type { TaskManager } from './task-manager.ts';
import type { Release, ReleaseData, RepoDocument, RepoUpdate } from './types.ts';

const API_TOKEN: string = config.telegram.token;
const PREVIEW_RELEASES_COUNT = -10;
const FIRST_UPDATE_RELEASES_COUNT = 5;
const UPDATE_INTERVAL = Math.floor((config.app.updateInterval / 60) * 100) / 100;

export interface SessionData {
  action: 'addRepo' | 'sendMessage' | null;
}

type BotContext = Context & SessionFlavor<SessionData>;
type Handler = (ctx: BotContext) => Promise<void>;
type ReleaseContext = { owner: string; name: string; release: string };
type SendFn = (message: string, keyboard: InlineKeyboard | null, repo: RepoDocument | RepoUpdate, shortFallback?: string, releaseCtx?: ReleaseContext) => Promise<void>;

const initialSession = (): SessionData => ({ action: null });

export class Bot {
  private bot: GrammyBot<BotContext>;
  private db: Db;
  private logger: Logger;
  private tasks: TaskManager;

  constructor(db: Db, storage: StorageAdapter<SessionData>, logger: Logger, tasks: TaskManager) {
    this.bot = new GrammyBot<BotContext>(API_TOKEN);
    this.db = db;
    this.logger = logger;
    this.tasks = tasks;

    this.bot.use(session({ initial: initialSession, storage }));
    this.bot.catch((err) => { this.logger.error({ err: err.error }, 'Bot error'); });

    this.bot.api.setMyCommands([
      { command: '/actions', description: 'Actions' },
      { command: '/about', description: 'About' },
    ]).catch((err: Error) => logger.error({ err }, 'setMyCommands failed'));

    this.listen();
    this.logger.info('Bot listen');
  }

  private listen(): void {
    this.bot.command('start',   this.wrapAction(this.start));
    this.bot.command('actions', this.wrapAction(this.actions));
    this.bot.command('about',   this.wrapAction(this.about));
    this.bot.command('admin',   this.wrapAction(this.admin));

    this.bot.callbackQuery('actionsList', this.wrapAction(this.actionsList));
    this.bot.callbackQuery('adminActionsList', this.wrapAction(this.adminActionsList));
    this.bot.callbackQuery('addRepo', this.wrapAction(this.addRepo));
    this.bot.callbackQuery('getReleases', this.wrapAction(this.getReleases));
    this.bot.callbackQuery(/^getReleases:expand:(\d+)\/(\d+)$/, this.wrapAction(this.getReleasesExpandRelease));
    this.bot.callbackQuery('getReleases:all', this.wrapAction(this.getReleasesAll));
    this.bot.callbackQuery('getReleases:one', this.wrapAction(this.getReleasesOne));
    this.bot.callbackQuery(/^getReleases:one:(\d+)$/, this.wrapAction(this.getReleasesOneRepo));
    this.bot.callbackQuery(/^getReleases:one:(\d+?):release:(\d+?)$/, this.wrapAction(this.getReleasesOneRepoRelease));
    this.bot.callbackQuery('editRepos', this.wrapAction(this.editRepos));
    this.bot.callbackQuery(/^editRepos:delete:(\d+)$/, this.wrapAction(this.editReposDelete));
    this.bot.callbackQuery('sendMessage', this.wrapAction(this.sendMessage));
    this.bot.callbackQuery('getStats', this.wrapAction(this.getStats));
    this.bot.callbackQuery('getRepoStats', this.wrapAction(this.getRepoStats));
    this.bot.callbackQuery('forceCheck', this.wrapAction(this.forceCheck));
    this.bot.callbackQuery('refreshData', this.wrapAction(this.refreshData));

    this.bot.on('message:text', this.wrapAction(this.handleAnswer));
    this.bot.start().catch((err: Error) => this.logger.error({ err }, 'Bot polling error'));
  }

  private wrapAction(action: Handler): Handler {
    return async (ctx: BotContext) => {
      try {
        await action.call(this, ctx);
      } catch (error) {
        this.logger.error({ err: error }, 'uncaughtException');
      }
    };
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async notifyUsers(repos: RepoUpdate[]): Promise<void> {
    const send: SendFn = async (message, keyboard, repo, shortFallback, releaseCtx) => {
      const watchedUsers = (repo as RepoUpdate).watchedUsers;
      await Promise.all(watchedUsers.map(async (userId) => {
        try {
          await this.bot.api.sendMessage(userId, message, {
            parse_mode: 'MarkdownV2',
            link_preview_options: { is_disabled: true },
            ...(keyboard ? { reply_markup: keyboard } : {}),
          });
        } catch (error) {
          this.logger.error({ err: error, userId, releaseCtx }, 'Failed to send full release, trying simplified');
          if (shortFallback) {
            try {
              await this.bot.api.sendMessage(userId, shortFallback, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                ...(keyboard ? { reply_markup: keyboard } : {}),
              });
            } catch (fallbackError) {
              this.logger.error({ err: fallbackError, userId, releaseCtx }, 'Failed to send simplified release');
            }
          }
        }
      }));
    };
    await this.sendReleases(null, repos, send);
  }

  private async start(ctx: BotContext): Promise<void> {
    await ctx.reply(greeting());
    await this.actions(ctx);
  }

  private async actions(ctx: BotContext): Promise<void> {
    ctx.session.action = null;
    const user = getUser(ctx);
    await this.db.createUser(user);
    await ctx.reply('Select an action', { reply_markup: keyboards.actionsList() });
  }

  private async admin(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      await ctx.reply('Select an action', { reply_markup: keyboards.adminActionsList() });
    });
  }

  private async about(ctx: BotContext): Promise<void> {
    await ctx.reply(about(UPDATE_INTERVAL), { parse_mode: 'Markdown' });
  }

  private async handleAnswer(ctx: BotContext): Promise<void> {
    if (!ctx.message?.text) return;
    const text = ctx.message.text;
    const user = getUser(ctx);

    if (!ctx.session.action) return;

    switch (ctx.session.action) {
      case 'addRepo': {
        const repo = parseRepo(text);
        if (!repo) {
          await ctx.reply('Invalid format. Please use owner/name or a GitHub URL:');
          return;
        }

        const hasRepoInDB = await this.db.getRepo(repo.owner, repo.name);
        if (!hasRepoInDB) {
          const fetchingMsg = await ctx.reply('Fetching repository info...');
          try {
            const releases = await getVersions(repo.owner, repo.name, FIRST_UPDATE_RELEASES_COUNT);
            await this.db.addRepo(repo.owner, repo.name);
            await this.db.updateRepo(repo.owner, repo.name, releases);
          } catch {
            await ctx.api.editMessageText(
              fetchingMsg.chat.id, fetchingMsg.message_id,
              'Could not fetch repository from GitHub. Check the name and try again:'
            );
            return;
          }
          await this.db.bindUserToRepo(user.id, repo.owner, repo.name);
          ctx.session.action = null;
          await ctx.api.editMessageText(
            fetchingMsg.chat.id, fetchingMsg.message_id,
            'Done! Add one more?', { reply_markup: keyboards.addOneMoreRepo() }
          );
        } else {
          await this.db.bindUserToRepo(user.id, repo.owner, repo.name);
          ctx.session.action = null;
          await ctx.reply('Done! Add one more?', { reply_markup: keyboards.addOneMoreRepo() });
        }
        break;
      }

      case 'sendMessage':
        await this.checkAdminPrivileges(ctx, async () => {
          const users = await this.db.getAllUsers();
          await Promise.all(users.map(async ({ userId, username, firstName, lastName }) => {
            try {
              await this.bot.api.sendMessage(userId, text, { parse_mode: 'Markdown' });
            } catch {
              this.logger.error({ userId, username, firstName, lastName }, 'Cannot send message to user');
            }
          }));
          ctx.session.action = null;
          await ctx.reply('Message sent');
        });
        break;

      default:
        ctx.session.action = null;
    }
  }

  private async addRepo(ctx: BotContext): Promise<void> {
    ctx.session.action = 'addRepo';
    await ctx.answerCallbackQuery();
    await this.editMessageText(ctx,
      'Please, send me the owner and name of repo (owner/name) or full url',
      { reply_markup: keyboards.backToActions() }
    );
  }

  private async editRepos(ctx: BotContext): Promise<void> {
    const repos = await this.db.getUserSubscriptions(getUser(ctx).id);

    await ctx.answerCallbackQuery();

    if (repos.length) {
      const kb = new InlineKeyboard();
      for (const repo of repos) {
        kb.url(`${repo.owner}/${repo.name}`, `https://github.com/${repo.owner}/${repo.name}`)
          .text('🗑️', `editRepos:delete:${repo.id}`)
          .row();
      }
      kb.text('Back', 'actionsList');
      await this.editMessageText(ctx, 'Your subscriptions', { reply_markup: kb });
    } else {
      await this.editMessageText(ctx, 'You do not have a subscriptions',
        { reply_markup: keyboards.backToActions() }
      );
    }
  }

  private async editReposDelete(ctx: BotContext): Promise<void> {
    const user = getUser(ctx);
    const match = ctx.match?.[1];
    if (!match) return;
    const repoId = parseInt(match);
    const repo = await this.db.getRepoById(repoId);
    if (!repo) {
      await this.dataBrokenException(ctx);
      return;
    }
    await this.db.unbindUserFromRepo(user.id, repo.owner, repo.name);
    await this.editRepos(ctx);
  }

  private async getReleases(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    await this.editMessageText(ctx, 'What list do you want to see?',
      { reply_markup: keyboards.allOrOneRepo() }
    );
  }

  private async getReleasesAll(ctx: BotContext): Promise<void> {
    const repos = await this.db.getUserSubscriptions(getUser(ctx).id);
    await ctx.answerCallbackQuery();
    const send: SendFn = async (text, keyboard) => {
      try {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to send release');
      }
    };
    await this.sendReleases(ctx, repos.map(getLastReleasesInRepos), send);
  }

  private async getReleasesOne(ctx: BotContext): Promise<void> {
    const repos = await this.db.getUserSubscriptions(getUser(ctx).id);

    await ctx.answerCallbackQuery();
    await this.editMessageText(ctx, 'Select repository',
      { reply_markup: keyboards.table(
        'getReleases',
        'getReleases:one',
        repos.map(({ id, owner, name }) => ({ label: `${owner}/${name}`, id }))
      )}
    );
  }

  private async getReleasesOneRepo(ctx: BotContext): Promise<void> {
    const matchId = ctx.match?.[1];
    if (!matchId) return;
    await ctx.answerCallbackQuery();

    const repoId = parseInt(matchId);
    const repo = await this.db.getRepoById(repoId);
    if (!repo) {
      await this.dataBrokenException(ctx);
      return;
    }

    const ok = await this.editMessageText(ctx, 'Select release',
      { reply_markup: keyboards.table(
        'getReleases:one',
        `getReleases:one:${repoId}:release`,
        repo.releases.slice(PREVIEW_RELEASES_COUNT).map(({ id, name: relName, isPrerelease }) => ({
          label: `${relName}${isPrerelease ? ' (pre-release)' : ''}`,
          id,
        }))
      )}
    );
    if (!ok) await this.dataBrokenException(ctx);
  }

  private async getReleasesOneRepoRelease(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();

    const [, matchRepoId, matchReleaseId] = ctx.match ?? [];
    if (!matchRepoId || !matchReleaseId) return;
    const repoId = parseInt(matchRepoId);
    const releaseId = parseInt(matchReleaseId);

    const repo = await this.db.getRepoById(repoId);
    if (!repo) {
      await this.dataBrokenException(ctx);
      return;
    }

    const release = repo.releases.find(r => r.id === releaseId);
    if (!release) {
      await this.dataBrokenException(ctx);
      return;
    }

    const send: SendFn = async (text, keyboard, _repo, shortFallback, releaseCtx) => {
      try {
        await ctx.reply(text, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      } catch (error) {
        this.logger.error({ err: error, releaseCtx }, 'Failed to send full release, trying simplified');
        if (shortFallback) {
          await ctx.reply(shortFallback, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(keyboard ? { reply_markup: keyboard } : {}),
          });
        }
      }
    };
    await this.sendReleases(null, [{ ...repo, releases: [release] }], send);
  }

  private async getReleasesExpandRelease(ctx: BotContext): Promise<void> {
    const [, matchRepoId, matchReleaseId] = ctx.match ?? [];
    if (!matchRepoId || !matchReleaseId) return;
    await ctx.answerCallbackQuery();

    const repoId = parseInt(matchRepoId);
    const releaseId = parseInt(matchReleaseId);

    const repo = await this.db.getRepoById(repoId);
    const release = repo?.releases.find(r => r.id === releaseId)
      ?? repo?.tags.find(t => t.id === releaseId);

    if (!repo || !release) {
      await this.dataBrokenException(ctx);
      return;
    }

    const { full } = getReleaseMessages(repo, release);
    const keyboard = release.url ? keyboards.releaseLink(release.url) : undefined;

    const ok = await this.editMessageText(ctx, full, {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    if (!ok) {
      await ctx.deleteMessage();
      await ctx.reply(full, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    }
  }

  private async sendReleases(
    ctx: BotContext | null,
    repos: Array<RepoDocument | RepoUpdate>,
    send: SendFn
  ): Promise<void> {
    for (const repo of repos) {
      const sendRelease = this.getReleaseSender(ctx, repo, send);
      for (const release of repo.releases) {
        await sendRelease(release);
      }
    }
  }

  private async actionsList(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    await this.editMessageText(ctx, 'Select an action', { reply_markup: keyboards.actionsList() });
  }

  private async adminActionsList(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    await this.editMessageText(ctx, 'Select an action', { reply_markup: keyboards.adminActionsList() });
  }

  private async sendMessage(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      ctx.session.action = 'sendMessage';
      await ctx.answerCallbackQuery();
      await this.editMessageText(ctx,
        'Please send me a message that will be sent to all users',
        { reply_markup: keyboards.backToAdminActions() }
      );
    });
  }

  private async getStats(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      await ctx.answerCallbackQuery();

      const users = await this.db.getAllUsers();
      const repos = await this.db.getAllReposNames();

      const groups = users.filter(({ type }) => type && type !== 'private');
      const groupsCount = groups.length;

      const chatsMembersCounts: (number | null)[] = await Promise.all(
        groups.map(({ userId }) =>
          this.bot.api.getChatMemberCount(userId).catch(() => null)
        )
      );

      const usersInGroups = chatsMembersCounts
        .filter((x): x is number => x !== null)
        .reduce((acc, count) => acc + count, 0);

      const chatsInfo = (await Promise.all(
        groups.map(({ userId }) =>
          this.bot.api.getChat(userId).catch(() => null)
        )
      ))
        .filter((info): info is NonNullable<typeof info> => info !== null)
        .map((info, index) => ({
          title: 'title' in info ? (info.title ?? '') : '',
          members: chatsMembersCounts[index] ?? null,
        }));

      const usersCount = users.filter(({ type }) => !type || type === 'private').length;
      const reposCount = repos.length;
      const averageSubscriptionsPerUser = (
        users.reduce((acc, { subscriptions }) => acc + subscriptions.length, 0) / users.length
      ).toFixed(2);
      const averageWatchPerRepo = (
        repos.reduce((acc, { watchedUsers = [] }) => acc + watchedUsers.length, 0) / repos.length
      ).toFixed(2);

      await ctx.reply(stats({
        groupsCount, usersCount, reposCount,
        averageSubscriptionsPerUser, averageWatchPerRepo,
        usersInGroups, chatsInfo,
      }));
    });
  }

  private async getRepoStats(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      await ctx.answerCallbackQuery();

      const repos = await this.db.getAllReposNames();

      if (!repos.length) {
        await this.editMessageText(ctx, 'No repositories yet.', { reply_markup: keyboards.backToAdminActions() });
        return;
      }

      const lines = repos
        .sort((a, b) => b.watchedUsers.length - a.watchedUsers.length)
        .map(({ owner, name, watchedUsers }) => `${owner}/${name} — ${watchedUsers.length}`);

      await this.editMessageText(ctx,
        `Repositories (${repos.length}):\n\n${lines.join('\n')}`,
        { reply_markup: keyboards.backToAdminActions() }
      );
    });
  }

  private async refreshData(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      await ctx.answerCallbackQuery();
      await this.editMessageText(ctx, 'Fetching from GitHub...', { reply_markup: keyboards.backToAdminActions() });

      const repos = await this.db.getAllReposNames();
      const data = await getManyVersionsInBunches(repos, 5);

      await this.db.clearAllReleasesAndTags();

      for (const repo of repos) {
        const releases = data.releases.find(r => r.owner === repo.owner && r.name === repo.name);
        const tags = data.tags.find(t => t.owner === repo.owner && t.name === repo.name);
        await this.db.updateRepo(repo.owner, repo.name, {
          releases: releases?.releases ?? [],
          tags: tags?.tags ?? [],
        });
      }

      await this.editMessageText(ctx, 'Done!', { reply_markup: keyboards.backToAdminActions() });
    });
  }

  private async forceCheck(ctx: BotContext): Promise<void> {
    await this.checkAdminPrivileges(ctx, async () => {
      await ctx.answerCallbackQuery();
      await this.editMessageText(ctx, 'Checking...', { reply_markup: keyboards.backToAdminActions() });
      await this.tasks.trigger('releases');
      await this.editMessageText(ctx, 'Done!', { reply_markup: keyboards.backToAdminActions() });
    });
  }

  private getReleaseSender(
    ctx: BotContext | null,
    repo: RepoDocument | RepoUpdate,
    send: SendFn
  ): (release: ReleaseData) => Promise<void> {
    return async (release: ReleaseData) => {
      const { full, short } = getReleaseMessages(repo, release);

      const releaseCtx: ReleaseContext = { owner: repo.owner, name: repo.name, release: release.name };
      if (ctx) {
        const repoId = (repo as RepoDocument).id;
        const keyboard = keyboards.expandButton(repoId, (release as Release).id, release.url);
        await send(short, keyboard, repo, undefined, releaseCtx);
      } else {
        const keyboard = release.url ? keyboards.releaseLink(release.url) : null;
        await send(full, keyboard, repo, short, releaseCtx);
      }
    };
  }

  private async dataBrokenException(ctx: BotContext): Promise<void> {
    const ok = await this.editMessageText(ctx,
      'Session data expired. Please use /actions to start over.'
    );
    if (!ok) await ctx.reply('Session data expired. Please use /actions to start over.');
  }

  private async checkAdminPrivileges(ctx: BotContext, cb: () => Promise<void>): Promise<void> {
    const user = getUser(ctx);
    if (user.username === config.adminUserName) {
      await cb();
    } else {
      await ctx.reply('You are not an administrator');
    }
  }

  private async editMessageText(
    ctx: BotContext,
    text: string,
    opts?: { reply_markup?: InlineKeyboard; parse_mode?: ParseMode; link_preview_options?: { is_disabled?: boolean } }
  ): Promise<boolean> {
    try {
      await ctx.editMessageText(text, opts);
      return true;
    } catch {
      return false;
    }
  }
}
