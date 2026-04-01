import { config } from './config.ts';
import type { Release, RepoIdentifier, RepoWithReleases, RepoWithTags, VersionUpdates } from './types.ts';

interface GraphQLClient {
  query: (query: string, variables?: unknown) => Promise<{ data: Record<string, unknown> }>;
}

interface ClientParams {
  url: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
}

interface RawRelease {
  url: string;
  isPrerelease: boolean;
  description: string;
  tag: { name: string } | null;
}

interface RawTag {
  name: string;
}

interface RawRepoData {
  releases?: { nodes: RawRelease[] };
  refs?: { nodes: RawTag[] };
}

const makeQuery = (query: string): string => `
query {
  ${query}
}`;

const getClient = (params: ClientParams): GraphQLClient => {
  if (!params.url) throw new Error('Missing url parameter');

  const headers = new Headers(params.headers);
  headers.append('Content-Type', 'application/json');

  return {
    query: async (query, variables) => {
      const req = new Request(params.url, {
        method: 'POST',
        body: JSON.stringify({ query: makeQuery(query), variables }),
        headers,
        credentials: params.credentials
      });

      const response = await fetch(req);
      const body = await response.json() as { data: Record<string, unknown>; errors?: unknown[] };

      if (body.errors && body.errors.length) {
        throw new Error(`Error while graphql request: ${JSON.stringify(body.errors, null, '  ')}`);
      }

      return body;
    }
  };
};

const client = getClient({
  url: config.github.url,
  headers: { Authorization: 'Bearer ' + config.github.token }
});

const prepareRelease = ({ url, isPrerelease, description, tag }: RawRelease): Release => ({
  url,
  description,
  isPrerelease,
  name: tag?.name ?? ''
});

const prepareReleases = (res: RawRepoData | null | undefined): Release[] =>
  res
    ? (res.releases?.nodes ?? [])
      .filter(Boolean)
      .filter(({ isPrerelease }) => config.app.includePrerelease || !isPrerelease)
      .map(prepareRelease)
    : [];

const prepareTag = (tag: RawTag): Release => ({
  url: '',
  description: '',
  isPrerelease: false,
  name: tag.name
});

const prepareTags = (res: RawRepoData | null | undefined): Release[] =>
  res ? (res.refs?.nodes ?? []).filter(Boolean).map(prepareTag) : [];

const releasesQuery = (owner: string, name: string, count: number): string => `
repository(owner:"${owner}", name:"${name}") {
  releases(first: ${count}) {
    nodes {
      url,
      isPrerelease,
      description,
      tag {
        name
      }
    }
  }
}`;

const tagsQuery = (owner: string, name: string, count: number): string => `
repository(owner:"${owner}", name:"${name}") {
  refs(last: ${count}, refPrefix: "refs/tags/") {
    nodes {
      name
    }
  }
}`;

const getReleases = (owner: string, name: string, count = 1): Promise<Release[]> =>
  client.query(releasesQuery(owner, name, count)).then(({ data }) => prepareReleases(data['repository'] as RawRepoData));

const getTags = (owner: string, name: string, count = 1): Promise<Release[]> =>
  client.query(tagsQuery(owner, name, count)).then(({ data }) => prepareTags(data['repository'] as RawRepoData));

export const getVersions = async (owner: string, name: string, count: number): Promise<{ releases: Release[]; tags: Release[] }> => {
  const [releases, tags] = await Promise.all([getReleases(owner, name, count), getTags(owner, name, count)]);
  return { releases, tags };
};

type QueryBuilder = (owner: string, name: string, count: number) => string;

const getMany = async (query: QueryBuilder, repos: RepoIdentifier[], count: number): Promise<Array<RepoIdentifier & { rawReleases: RawRepoData }>> => {
  if (repos.length) {
    const { data } = await client.query(
          repos.map((repo, index) => `repo_${index}: ${query(repo.owner, repo.name, count)}`).join('\n')
      );
      return data
          ? repos.map((repo_1, index_1) => ({ ...repo_1, rawReleases: data['repo_' + index_1] as RawRepoData }))
          : [];
  }
  return Promise.resolve([]);
};

const parseMany = <T extends { releases: Release[] } | { tags: Release[] }>(
  parser: (raw: RawRepoData) => Release[],
  toField: string
) => (data: Array<RepoIdentifier & { rawReleases: RawRepoData }> = []): T[] =>
  data.map(({ owner, name, rawReleases }) => ({
    owner,
    name,
    [toField]: parser(rawReleases)
  } as unknown as T));

const getManyReleases = (repos: RepoIdentifier[], count: number): Promise<RepoWithReleases[]> =>
  getMany(releasesQuery, repos, count).then(parseMany<RepoWithReleases>(prepareReleases, 'releases'));

const getManyTags = (repos: RepoIdentifier[], count: number): Promise<RepoWithTags[]> =>
  getMany(tagsQuery, repos, count).then(parseMany<RepoWithTags>(prepareTags, 'tags'));

const getManyVersions = async (repos: RepoIdentifier[], count: number): Promise<VersionUpdates> => {
  const releasesData = await getManyReleases(repos, count);
  const releasesUpdates = releasesData.filter(({ releases }) => releases.length);
  const tagsData = await getManyTags(repos, count);
  const tagsUpdates = tagsData.filter(({ tags }) => tags.length);

  return { releases: releasesUpdates, tags: tagsUpdates };
};

const BUNCH_SIZE = 50;

export const getManyVersionsInBunches = async (repos: RepoIdentifier[], count: number): Promise<VersionUpdates> => {
  const bunchesCount = Math.ceil(repos.length / BUNCH_SIZE);

  const resultedBunches = await Promise.all(
    Array(bunchesCount)
      .fill(null)
      .map((_, index) => getManyVersions(repos.slice(index * BUNCH_SIZE, index * BUNCH_SIZE + BUNCH_SIZE), count))
  );

  return resultedBunches.reduce<VersionUpdates>(
    (acc, { tags, releases }) => ({
      releases: acc.releases.concat(releases),
      tags: acc.tags.concat(tags)
    }),
    { releases: [], tags: [] }
  );
};
