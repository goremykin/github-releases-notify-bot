interface StatsParams {
  groupsCount: number;
  usersCount: number;
  reposCount: number;
  averageSubscriptionsPerUser: string;
  averageWatchPerRepo: string;
  usersInGroups: number;
  chatsInfo: Array<{ title: string; members: number | null }>;
}

export const about = (interval: number): string => `
Bot to notify you about new releases in the repositories that you add to the subscription. New releases are checked every ${interval} minutes.

*GitHub repository* - [goremykin/github-releases-notify-bot](https://github.com/goremykin/github-releases-notify-bot)
`;

export const greeting = (): string => `
Hello!

That bot can notify you about new releases.
To receive a notification, you must subscribe to repos that you would like to observe.
To do this, click the "Add repository" button.

In addition, you can see the latest releases of your observed repositories.
To do this, click the "Get Releases" button.
`;

export const stats = ({
  groupsCount,
  usersCount,
  reposCount,
  averageSubscriptionsPerUser,
  averageWatchPerRepo,
  usersInGroups,
  chatsInfo
}: StatsParams): string => `
Stats

Groups count: ${groupsCount}
Users count: ${usersCount}
Users in groups count: ${usersInGroups}
Repos count: ${reposCount}
Average subscriptions per user: ${averageSubscriptionsPerUser}
Average watch per repo: ${averageWatchPerRepo}

${chatsInfo.length ? `Chats:\n${chatsInfo.map(({ title, members }) => `${title} - ${members}`).join('\n')}` : ''}
`;
