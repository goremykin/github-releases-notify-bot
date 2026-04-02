export interface GithubConfig {
  token: string;
  url: string;
}

export interface SqliteConfig {
  path: string;
}

export interface TelegramConfig {
  token: string;
}

export interface AppConfig {
  updateInterval: number;
  restartRate: number;
  includePrerelease: boolean;
  prettyLogs: boolean;
}

export interface Config {
  github: GithubConfig;
  sqlite: SqliteConfig;
  telegram: TelegramConfig;
  adminUserName: string;
  app: AppConfig;
}

export interface ReleaseData {
  url: string;
  description: string;
  isPrerelease: boolean;
  name: string;
}

export interface Release extends ReleaseData {
  id: number;
}

export interface RepoIdentifier {
  owner: string;
  name: string;
}

export interface RepoDocument extends RepoIdentifier {
  id: number;
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
  releases: ReleaseData[];
  watchedUsers?: number[];
}

export interface RepoWithTags extends RepoIdentifier {
  tags: ReleaseData[];
  watchedUsers?: number[];
}

export interface VersionUpdates {
  releases: RepoWithReleases[];
  tags: RepoWithTags[];
}

export interface RepoUpdate extends RepoIdentifier {
  releases: ReleaseData[];
  watchedUsers: number[];
  tags?: ReleaseData[];
}
