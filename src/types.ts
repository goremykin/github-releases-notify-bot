export interface GithubConfig {
  token: string;
  url: string;
}

export interface MongoConfig {
  name: string;
  url: string;
}

export interface SqliteConfig {
  path: string;
}

export interface TelegramConfig {
  token: string;
  proxy: string;
}

export interface AppConfig {
  updateInterval: number;
  restartRate: number;
  includePrerelease: boolean;
  prettyLogs: boolean;
}

export interface Config {
  github: GithubConfig;
  mongodb: MongoConfig;
  sqlite: SqliteConfig;
  telegram: TelegramConfig;
  adminUserName: string;
  app: AppConfig;
}

export interface Release {
  url: string;
  description: string;
  isPrerelease: boolean;
  name: string;
}

export interface RepoIdentifier {
  owner: string;
  name: string;
}

export interface RepoDocument extends RepoIdentifier {
  watchedUsers: number[];
  releases: Release[];
  tags: Release[];
}

export interface UserDocument {
  userId: number;
  subscriptions: RepoIdentifier[];
  type: string;
  username: string;
  date: string;
  isBot?: boolean;
  firstName?: string;
  lastName?: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  type: string;
  username?: string;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  title?: string;
}

export interface RepoWithReleases extends RepoIdentifier {
  releases: Release[];
  watchedUsers?: number[];
}

export interface RepoWithTags extends RepoIdentifier {
  tags: Release[];
  watchedUsers?: number[];
}

export interface VersionUpdates {
  releases: RepoWithReleases[];
  tags: RepoWithTags[];
}

export interface RepoUpdate extends RepoIdentifier {
  releases: Release[];
  watchedUsers: number[];
  tags?: Release[];
}
