import Telegraf from 'telegraf';
import { SocksProxyAgent } from 'socks-proxy-agent';

import * as keyboards from './keyboards.ts';
import { about, greeting, stats } from './texts.ts';
import { getUser, parseRepo, getLastReleasesInRepos, getReleaseMessages } from './utils.ts';
import { getVersions } from './github-client.ts';
import config from '../config.json' with { type: 'json' };
import type { Db } from './db.ts';
import type { Logger } from './logger.ts';
import type { RepoDocument, RepoUpdate } from './types.ts';

const { Extra, Markup, session } = Telegraf as {
  Extra: { markdown: () => unknown };
  Markup: { urlButton: (t: string, u: string) => unknown; callbackButton: (t: string, a: string) => unknown; inlineKeyboard: (b: unknown[]) => { extra: () => unknown } };
  session: () => unknown;
};

const API_TOKEN: string = config.telegram.token || '';
const PROXY_OPTIONS: string = config.telegram.proxy || '';

const PREVIEW_RELEASES_COUNT = -10;
const FIRST_UPDATE_RELEASES_COUNT = 5;
const UPDATE_INTERVAL = Math.floor((config.app.updateInterval / 60) * 100) / 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;
type ActionFn = (ctx: Ctx, next: (() => void) | undefined) => Promise<unknown>;

export class Bot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any;
  private db: Db;
  private logger: Logger;

  constructor(db: Db, logger: Logger) {
    this.bot = new (Telegraf as { new(token: string, opts: unknown): unknown })(API_TOKEN, {
      telegram: PROXY_OPTIONS ? { agent: new SocksProxyAgent(PROXY_OPTIONS) } : {},
      channelMode: false
    });
    this.db = db;
    this.logger = logger;

    this.bot.use(session());
    this.bot.catch((err: Error) => { this.logger.error({ err }, 'Bot error'); });

    this.bot.telegram.getMe().then((botInfo: { username: string }) => {
      this.bot.options.username = botInfo.username;
    });

    this.bot.telegram.setMyCommands([
      { command: '/actions', description: 'Actions' },
      { command: '/about', description: 'About' }
    ]).catch((err: Error) => logger.error({ err }, 'setMyCommands failed'));

    this.listen();
    this.logger.info('Bot listen');
  }

  private listen(): void {
    const commands: [string, ActionFn][] = [
      ['start', this.start],
      ['actions', this.actions],
      ['about', this.about],
      ['admin', this.admin]
    ];
    const actions: [string | RegExp, ActionFn][] = [
      ['actionsList', this.actionsList],
      ['adminActionsList', this.adminActionsList],
      ['addRepo', this.addRepo],
      ['getReleases', this.getReleases],
      [/^getReleases:expand:(.+)$/, this.getReleasesExpandRelease],
      ['getReleases:all', this.getReleasesAll],
      ['getReleases:one', this.getReleasesOne],
      [/^getReleases:one:(\d+)$/, this.getReleasesOneRepo],
      [/^getReleases:one:(\d+?):release:(\d+?)$/, this.getReleasesOneRepoRelease],
      ['editRepos', this.editRepos],
      [/^editRepos:delete:(.+)$/, this.editReposDelete],
      ['sendMessage', this.sendMessage],
      ['getStats', this.getStats]
    ];

    commands.forEach(([command, fn]) => this.bot.command(command, this.wrapAction(fn)));
    actions.forEach(([action, fn]) => this.bot.action(action, this.wrapAction(fn)));
    this.bot.hears(/.+/, this.wrapAction(this.handleAnswer));
    this.bot.startPolling();
  }

  private wrapAction(action: ActionFn): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
      try {
        return await action.apply(this, args as Parameters<ActionFn>);
      } catch (error) {
        this.logger.error({ err: error }, 'uncaughtException');
      }
    };
  }

  async notifyUsers(repos: RepoUpdate[]): Promise<void> {
    await this.sendReleases(
      null,
      repos,
      async (markdown: string, _key: unknown, { watchedUsers }: { watchedUsers: number[] }) => {
        await Promise.all(watchedUsers.map(async (userId) => {
          try {
            await this.bot.telegram.sendMessage(userId, markdown, Extra.markdown());
          } catch (error) {
            this.logger.error({ err: error, userId }, 'Cannot send release to user');
          }
        }));
      }
    );
  }

  private async start(ctx: Ctx): Promise<void> {
    await ctx.reply(greeting());
    return this.actions(ctx);
  }

  private async actions(ctx: Ctx): Promise<void> {
    ctx.session.action = null;
    const user = getUser(ctx);
    await this.db.createUser(user);
    return ctx.reply('Select an action', keyboards.actionsList());
  }

  private admin(ctx: Ctx): Promise<unknown> {
    return this.checkAdminPrivileges(ctx, () => ctx.reply('Select an action', keyboards.adminActionsList()));
  }

  private about(ctx: Ctx): Promise<unknown> {
    return ctx.replyWithMarkdown(about(UPDATE_INTERVAL));
  }

  private async handleAnswer(ctx: Ctx, next: (() => void) | undefined): Promise<unknown> {
    const str: string = ctx.match[0];
    const user = getUser(ctx);

    if (ctx.session.action) {
      switch (ctx.session.action) {
        case 'addRepo': {
          const repo = parseRepo(str);

          if (repo) {
            const hasRepoInDB = await this.db.getRepo(repo.owner, repo.name);

            if (!hasRepoInDB) {
              try {
                const releases = await getVersions(repo.owner, repo.name, FIRST_UPDATE_RELEASES_COUNT);
                await this.db.addRepo(repo.owner, repo.name);
                await this.db.updateRepo(repo.owner, repo.name, releases);
              } catch {
                return ctx.reply('Cannot subscribe to this repo. Please enter another:');
              }
            }

            await this.db.bindUserToRepo(user.id, repo.owner, repo.name);
            ctx.session.action = null;
            return ctx.reply('Done! Add one more?', keyboards.addOneMoreRepo());
          } else {
            return ctx.reply('Cannot subscribe to this repo. Please enter another:');
          }
        }
        case 'sendMessage':
          return this.checkAdminPrivileges(ctx, async () => {
            const users = await this.db.getAllUsers();

            await Promise.all(users.map(async ({ userId, username, firstName, lastName }) => {
              try {
                await this.bot.telegram.sendMessage(userId, ctx.match.input, Extra.markdown());
              } catch {
                this.logger.error({ userId, username, firstName, lastName }, 'Cannot send message to user');
              }
            }));

            ctx.session.action = null;
            return ctx.reply('Message sent');
          });
        default:
          ctx.session.action = null;
          return next?.();
      }
    }
  }

  private async addRepo(ctx: Ctx): Promise<unknown> {
    ctx.session.action = 'addRepo';
    await ctx.answerCbQuery('');
    return this.editMessageText(ctx, 'Please, send me the owner and name of repo (owner/name) or full url', keyboards.backToActions());
  }

  private async editRepos(ctx: Ctx): Promise<unknown> {
    const user = await this.db.getUser(getUser(ctx).id);
    const subscriptions = user?.subscriptions ?? [];

    await ctx.answerCbQuery('');

    if (subscriptions.length) {
      const row = (repo: { owner: string; name: string }) => [
        Markup.urlButton(`${repo.owner}/${repo.name}`, `https://github.com/${repo.owner}/${repo.name}`),
        Markup.callbackButton('🗑️', `editRepos:delete:${repo.owner}/${repo.name}`)
      ];

      return this.editMessageText(ctx,
        'Your subscriptions',
        Markup.inlineKeyboard([...subscriptions.map(row), [Markup.callbackButton('Back', 'actionsList')]]).extra()
      );
    } else {
      return this.editMessageText(ctx, 'You do not have a subscriptions', keyboards.backToActions());
    }
  }

  private async editReposDelete(ctx: Ctx): Promise<unknown> {
    const user = getUser(ctx);
    const [owner, name] = (ctx.match[1] as string).split('/');
    await this.db.unbindUserFromRepo(user.id, owner, name);
    return this.editRepos(ctx);
  }

  private async getReleases(ctx: Ctx): Promise<unknown> {
    await ctx.answerCbQuery('');
    return this.editMessageText(ctx, 'What list do you want to see?', keyboards.allOrOneRepo());
  }

  private async getReleasesAll(ctx: Ctx): Promise<unknown> {
    const repos = await this.db.getUserSubscriptions(getUser(ctx).id);
    await ctx.answerCbQuery('');
    return this.sendReleases(ctx, repos.map(getLastReleasesInRepos), ctx.replyWithHTML);
  }

  private async getReleasesOne(ctx: Ctx): Promise<unknown> {
    const user = await this.db.getUser(getUser(ctx).id);
    const subscriptions = user?.subscriptions ?? [];

    ctx.session.subscriptions = subscriptions;
    await ctx.answerCbQuery('');

    return this.editMessageText(ctx, 'Select repository',
      keyboards.table(
        'getReleases',
        'getReleases:one',
        subscriptions.map(({ owner, name }: { owner: string; name: string }) => `${owner}/${name}`)
      )
    );
  }

  private async getReleasesOneRepo(ctx: Ctx): Promise<unknown> {
    await ctx.answerCbQuery('');

    const index = parseInt(ctx.match[1]);

    if (ctx.session.subscriptions?.[index]) {
      const { owner, name } = ctx.session.subscriptions[index];
      const repo = await this.db.getRepo(owner, name);
      if (!repo) return;

      const result = this.editMessageText(ctx, 'Select release',
        keyboards.table(
          'getReleases:one',
          `getReleases:one:${index}:release`,
          repo.releases.slice(PREVIEW_RELEASES_COUNT).map(({ name, isPrerelease }: { name: string; isPrerelease: boolean }) =>
            `${name}${isPrerelease ? ' (pre-release)' : ''}`)
        )
      );

      return this.checkForException(ctx, result);
    }
  }

  private async getReleasesOneRepoRelease(ctx: Ctx): Promise<unknown> {
    await ctx.answerCbQuery('');

    try {
      const repoIndex = parseInt(ctx.match[1]);
      const releaseIndex = parseInt(ctx.match[2]);

      if (ctx.session.subscriptions?.[repoIndex]) {
        const { owner, name } = ctx.session.subscriptions[repoIndex];
        const repo = await this.db.getRepo(owner, name);
        if (!repo) return;

        return this.sendReleases(
          null,
          [{ ...repo, releases: [repo.releases.slice(PREVIEW_RELEASES_COUNT)[releaseIndex]] }],
          ctx.replyWithMarkdown
        );
      }
    } catch {
      return this.dataBrokenException(ctx);
    }
  }

  private async getReleasesExpandRelease(ctx: Ctx): Promise<unknown> {
    const data: string = ctx.match[1];
    await ctx.answerCbQuery('');

    const index = parseInt(data);
    const releases: string[][] | undefined = ctx.session.releasesDescriptions;

    if (releases?.[index]) {
      if (releases[index].length <= 1) {
        const result = await this.editMessageText(ctx, releases[index][0], Extra.markdown());
        return result === null ? this.dataBrokenException(ctx) : result;
      } else {
        return releases[index]
          .reduce((promise: Promise<unknown>, message: string) =>
            promise.then(() => ctx.replyWithMarkdown(message, Extra.markdown())),
            ctx.deleteMessage(ctx.update.callback_query.id));
      }
    } else {
      return this.dataBrokenException(ctx);
    }
  }

  private async sendReleases(
    ctx: Ctx | null,
    repos: Array<RepoDocument | RepoUpdate>,
    send: (message: string, key: unknown, repo: RepoDocument | RepoUpdate) => Promise<unknown>
  ): Promise<void> {
    if (ctx) {
      ctx.session.releasesDescriptions = [];
    }

    await repos.reduce<Promise<unknown>>((promise, repo) => {
      const sendRelease = this.getReleaseSender(ctx, repo, send);
      return repo.releases.reduce<Promise<unknown>>(
        (stream, release) => stream.then(() => sendRelease(stream, release)),
        promise
      );
    }, Promise.resolve());
  }

  private async actionsList(ctx: Ctx): Promise<unknown> {
    await ctx.answerCbQuery('');
    return this.editMessageText(ctx, 'Select an action', keyboards.actionsList());
  }

  private async adminActionsList(ctx: Ctx): Promise<unknown> {
    await ctx.answerCbQuery('');
    return this.editMessageText(ctx, 'Select an action', keyboards.adminActionsList());
  }

  private sendMessage(ctx: Ctx): Promise<unknown> {
    return this.checkAdminPrivileges(ctx, async () => {
      ctx.session.action = 'sendMessage';
      await ctx.answerCbQuery('');
      return this.editMessageText(ctx, 'Please send me a message that will be sent to all users', keyboards.backToAdminActions());
    });
  }

  private async getStats(ctx: Ctx): Promise<unknown> {
    return this.checkAdminPrivileges(ctx, async () => {
      const users = await this.db.getAllUsers();
      const repos = await this.db.getAllReposNames();

      const groups = users.filter(({ type }) => type && type !== 'private');
      const groupsCount = groups.length;

      const chatsMembersCounts = await Promise.all(
        groups
          .map(({ userId }) => this.bot.telegram.getChatMembersCount(userId))
          .map((promise: Promise<number>) => promise.catch(() => null))
      );

      const usersInGroups = (chatsMembersCounts as (number | null)[])
        .filter((x): x is number => x !== null)
        .reduce((acc, count) => acc + count, 0);

      const chatsInfo = (await Promise.all(
        groups
          .map(({ userId }) => this.bot.telegram.getChat(userId))
          .map((promise: Promise<unknown>) => promise.catch(() => null))
      ))
        .filter(Boolean)
        .map((info, index) => ({ ...(info as object), members: (chatsMembersCounts as (number | null)[])[index] ?? null })) as Array<{ title: string; members: number | null }>;

      const usersCount = users.filter(({ type }) => !type || type === 'private').length;
      const reposCount = repos.length;
      const averageSubscriptionsPerUser = (users.reduce((acc, { subscriptions }) => acc + subscriptions.length, 0) / users.length).toFixed(2);
      const averageWatchPerRepo = (repos.reduce((acc, { watchedUsers = [] }) => acc + watchedUsers.length, 0) / repos.length).toFixed(2);

      return ctx.reply(stats({ groupsCount, usersCount, reposCount, averageSubscriptionsPerUser, averageWatchPerRepo, usersInGroups, chatsInfo }));
    });
  }

  private getReleaseSender(
    ctx: Ctx | null,
    repo: RepoDocument | RepoUpdate,
    send: (message: string, key: unknown, repo: RepoDocument | RepoUpdate) => Promise<unknown>
  ) {
    return async (promise: Promise<unknown>, release: { name: string; url?: string; isPrerelease?: boolean; description?: string }) => {
      const { full, short } = getReleaseMessages(repo, release);

      if (ctx) {
        ctx.session.releasesDescriptions.push(full);
        const key = keyboards.expandButton(ctx.session.releasesDescriptions.length - 1);
        await promise;
          return await send(short, key, repo);
      } else {
        return full.reduce(
          (stream: Promise<unknown>, message: string) => stream.then(() => send(message, '', repo)),
          promise
        );
      }
    };
  }

  private dataBrokenException(ctx: Ctx): Promise<unknown> {
    try {
      return this.editMessageText(ctx, 'Data is broken');
    } catch {
      return ctx.reply('Data is broken');
    }
  }

  private async checkAdminPrivileges(ctx: Ctx, cb: () => Promise<unknown>): Promise<unknown> {
    const user = getUser(ctx);
    if (user.username === config.adminUserName) {
      return cb();
    }
    return ctx.reply('You are not an administrator');
  }

  private async checkForException(ctx: Ctx, result: unknown): Promise<unknown> {
    return (await (result as Promise<unknown>)) === null ? this.dataBrokenException(ctx) : result;
  }

  private async editMessageText(ctx: Ctx, ...message: unknown[]): Promise<unknown> {
    try {
      return await ctx.editMessageText(...message);
    } catch {
      return null;
    }
  }
}
