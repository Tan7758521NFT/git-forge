// graphql.ts — GraphQL v4 (/api/graphql): hand-written parser + executor for
// the query documents gh and github-mcp-server send, plus __type introspection.
import {
  decodeGlobalId,
  encodeGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------ parser
type GQLValue =
  | string
  | number
  | boolean
  | null
  | GQLValue[]
  | { [key: string]: GQLValue };

interface GQLField {
  alias: string | null;
  name: string;
  args: Record<string, GQLValue>;
  selection: GQLField[] | null;
}

interface GQLOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GQLField[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'var';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') {
        while (i < src.length && src[i] !== '\n') i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!@=[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private variables: Record<string, GQLValue>;
  private fragments = new Map<string, GQLField[]>();

  constructor(src: string, variables: Record<string, GQLValue>) {
    this.tokens = tokenize(src);
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`GraphQL: expected '${value}'`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('GraphQL: expected a name');
    if (value !== undefined && t.value !== value) throw new Error(`GraphQL: expected '${value}'`);
    return t.value;
  }

  parseDocument(): GQLOperation[] {
    const operations: GQLOperation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.parseFragmentDefinition();
      } else if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private parseOperation(): GQLOperation {
    const type = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    const t = this.peek();
    if (t && t.kind === 'name') name = this.next().value;
    // Variable definitions: ($x: Type = default, ...)
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0 && this.pos < this.tokens.length) {
        const tok = this.next();
        if (tok.kind === 'punct' && tok.value === '(') depth += 1;
        else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
      }
    }
    // Directives: @name(...) — skip.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    return { type, name, selection: this.parseSelectionSet() };
  }

  private parseFragmentDefinition(): void {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    this.expectName(); // type condition
    this.fragments.set(name, this.parseSelectionSet());
  }

  private parseSelectionSet(): GQLField[] {
    this.expectPunct('{');
    const fields: GQLField[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '}') {
        this.next();
        return fields;
      }
      if (t.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next && next.kind === 'name' && next.value === 'on') {
          this.next();
          this.expectName(); // type condition
          fields.push(...this.parseSelectionSet());
        } else if (next && next.kind === 'name') {
          const fragName = this.next().value;
          const frag = this.fragments.get(fragName);
          if (frag) fields.push(...frag);
        } else {
          fields.push(...this.parseSelectionSet());
        }
        continue;
      }
      fields.push(this.parseField());
    }
    throw new Error('GraphQL: unterminated selection set');
  }

  private parseField(): GQLField {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, GQLValue> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    // Directives on the field: skip.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    let selection: GQLField[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  private parseArguments(): Record<string, GQLValue> {
    this.expectPunct('(');
    const args: Record<string, GQLValue> = {};
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    throw new Error('GraphQL: unterminated arguments');
  }

  private parseValue(): GQLValue {
    const t = this.next();
    if (t.kind === 'var') {
      const v = this.variables[t.value];
      return v === undefined ? null : v;
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return Number.parseInt(t.value, 10);
    if (t.kind === 'float') return Number.parseFloat(t.value);
    if (t.kind === 'punct' && t.value === '[') {
      const arr: GQLValue[] = [];
      while (this.pos < this.tokens.length) {
        const n = this.peek()!;
        if (n.kind === 'punct' && n.value === ']') {
          this.next();
          return arr;
        }
        arr.push(this.parseValue());
      }
      throw new Error('GraphQL: unterminated list');
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: { [key: string]: GQLValue } = {};
      while (this.pos < this.tokens.length) {
        const n = this.peek()!;
        if (n.kind === 'punct' && n.value === '}') {
          this.next();
          return obj;
        }
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      throw new Error('GraphQL: unterminated input object');
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum value: keep as its name string
    }
    throw new Error(`GraphQL: unexpected token ${t.kind} ${t.value}`);
  }
}

// ------------------------------------------------------------------ execution
export class GQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GQLError';
  }
}

interface Ctx {
  store: Store;
}

type NodeValue = Record<string, unknown> & { __typename: string };

function node(typeName: string, props: Record<string, unknown>): NodeValue {
  return { __typename: typeName, ...props };
}

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'closedAt'];
const PULL_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'closedAt'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'defaultBranch', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url'];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'];

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(ctx: Ctx, repo: Repo, issue: Issue): NodeValue {
  return node('Issue', { repo, issue });
}

function pullNode(ctx: Ctx, repo: Repo, pull: Pull): NodeValue {
  return node('PullRequest', { repo, pull });
}

function repoNode(ctx: Ctx, repo: Repo): NodeValue {
  return node('Repository', { repo });
}

function findIssueByGlobalId(ctx: Ctx, globalId: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(globalId);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repoId = Math.floor(decoded.id / 100000);
  const number = decoded.id % 100000;
  const repo = ctx.store.reposById.get(repoId);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(ctx: Ctx, globalId: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(globalId);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repoId = Math.floor(decoded.id / 100000);
  const number = decoded.id % 100000;
  const repo = ctx.store.reposById.get(repoId);
  if (!repo) return null;
  const pull = repo.pulls.get(number);
  return pull ? { repo, pull } : null;
}

function resolveField(parent: NodeValue, field: GQLField, ctx: Ctx): unknown {
  const typeName = parent.__typename;
  const name = field.name;
  // __typename is available on every object.
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') {
        return node('User', { login: ctx.store.viewerLogin ?? 'viewer' });
      }
      if (name === 'repository') {
        const owner = field.args.owner as string;
        const repoName = field.args.name as string;
        const repo = ctx.store.findRepo(owner, repoName);
        return repo ? repoNode(ctx, repo) : null;
      }
      if (name === 'node') {
        const id = field.args.id as string;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = ctx.store.reposById.get(decoded.id);
          return repo ? repoNode(ctx, repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(ctx, id);
          return found ? issueNode(ctx, found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(ctx, id);
          return found ? pullNode(ctx, found.repo, found.pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeNameArg = field.args.name as string;
        if (typeNameArg === 'Issue') return node('__Type', { typeName: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS, enumValues: null });
        if (typeNameArg === 'PullRequest') return node('__Type', { typeName: 'PullRequest', kind: 'OBJECT', fields: PULL_FIELDS, enumValues: null });
        if (typeNameArg === 'Repository') return node('__Type', { typeName: 'Repository', kind: 'OBJECT', fields: REPO_FIELDS, enumValues: null });
        if (typeNameArg === 'SearchType') return node('__Type', { typeName: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES });
        return null;
      }
      if (name === '__schema') {
        return node('__Schema', {});
      }
      throw new GQLError(`Cannot query field "${name}" on type "Query".`);
    }
    case 'User': {
      if (name === 'login') return parent.login as string;
      if (name === 'id') return encodeGlobalId('User', 1);
      throw new GQLError(`Cannot query field "${name}" on type "User".`);
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      const login = ctx.store.viewerLogin ?? 'viewer';
      if (name === 'id') return encodeGlobalId('Repository', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${login}/${repo.name}`;
      if (name === 'owner') return node('User', { login });
      if (name === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? node('Ref', { name: repo.defaultBranch }) : null;
      }
      if (name === 'defaultBranch') return repo.defaultBranch;
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.isPrivate;
      if (name === 'url') return `https://github.com/${login}/${repo.name}`;
      if (name === 'createdAt' || name === 'updatedAt') return '2025-01-01T00:00:00Z';
      if (name === 'issue') {
        const number = field.args.number as number;
        const issue = repo.issues.get(number);
        return issue ? issueNode(ctx, repo, issue) : null;
      }
      if (name === 'issues') {
        let list = [...repo.issues.values()];
        const states = field.args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s)));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = field.args.orderBy as Record<string, unknown> | undefined;
        const direction = orderBy?.direction === 'DESC' ? -1 : 1;
        list.sort((a, b) => direction * (a.number - b.number));
        return paginateIssues(ctx, repo, list, field.args);
      }
      if (name === 'pullRequest') {
        const number = field.args.number as number;
        const pull = repo.pulls.get(number);
        return pull ? pullNode(ctx, repo, pull) : null;
      }
      if (name === 'pullRequests') {
        let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
        list.sort((a, b) => b.number - a.number);
        return paginatePulls(ctx, repo, list, field.args);
      }
      throw new GQLError(`Cannot query field "${name}" on type "Repository".`);
    }
    case 'Ref': {
      if (name === 'name') return parent.name as string;
      throw new GQLError(`Cannot query field "${name}" on type "Ref".`);
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      if (name === 'id') return encodeGlobalId('Issue', issue.id);
      if (name === 'databaseId') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issueState(issue);
      if (name === 'author') return node('User', { login: ctx.store.viewerLogin ?? 'viewer' });
      if (name === 'url') return `https://github.com/${ctx.store.viewerLogin ?? 'viewer'}/${(parent.repo as Repo).name}/issues/${issue.number}`;
      if (name === 'createdAt' || name === 'updatedAt') return '2025-01-01T00:00:00Z';
      if (name === 'closedAt') return issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null;
      if (name === 'labels') return node('LabelConnection', { nodes: [] });
      if (name === 'comments') return node('IssueCommentConnection', { nodes: [] });
      throw new GQLError(`Cannot query field "${name}" on type "Issue".`);
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (name === 'id') return encodeGlobalId('PullRequest', pull.id);
      if (name === 'databaseId') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'headRef') return node('Ref', { name: pull.headRef });
      if (name === 'baseRef') return node('Ref', { name: pull.baseRef });
      if (name === 'mergeable') return ctx.store.mergeable(repo, pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergeCommit') return pull.mergeCommitSha ? node('Commit', { oid: pull.mergeCommitSha }) : null;
      if (name === 'author') return node('User', { login: ctx.store.viewerLogin ?? 'viewer' });
      if (name === 'url') return `https://github.com/${ctx.store.viewerLogin ?? 'viewer'}/${repo.name}/pull/${pull.number}`;
      if (name === 'createdAt' || name === 'updatedAt') return '2025-01-01T00:00:00Z';
      if (name === 'closedAt') return pull.state === 'closed' ? '2025-01-01T00:00:00Z' : null;
      if (name === 'files') {
        const base = repo.mergeBase(pull.headSha, pull.baseSha);
        const ancestorFiles = base ? repo.flattenTree(repo.treeOf(base)) : new Map<string, { mode: string; oid: string }>();
        const headFiles = repo.flattenTree(repo.treeOf(pull.headSha));
        const paths: string[] = [];
        for (const [path] of headFiles) if (!ancestorFiles.has(path) || ancestorFiles.get(path)!.oid !== headFiles.get(path)!.oid) paths.push(path);
        for (const [path] of ancestorFiles) if (!headFiles.has(path)) paths.push(path);
        paths.sort();
        const first = typeof field.args.first === 'number' ? field.args.first : 100;
        const nodes = paths.slice(0, first).map((p) => node('PullRequestFile', { path: p }));
        return node('PullRequestFileConnection', { nodes, pageInfo: { hasNextPage: paths.length > first, endCursor: paths.length > 0 ? encodeCursor(paths.length) : null } });
      }
      throw new GQLError(`Cannot query field "${name}" on type "PullRequest".`);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection': {
      if (name === 'nodes') return parent.nodes as unknown[];
      if (name === 'edges') return (parent.nodes as unknown[]).map((n) => node('Edge', { node: n }));
      if (name === 'pageInfo') return parent.pageInfo ?? { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
      if (name === 'totalCount') return (parent.nodes as unknown[]).length;
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
    }
    case 'Edge': {
      if (name === 'node') return parent.node as unknown;
      if (name === 'cursor') return encodeCursor(0);
      throw new GQLError(`Cannot query field "${name}" on type "Edge".`);
    }
    case 'PullRequestFile': {
      if (name === 'path') return parent.path as string;
      throw new GQLError(`Cannot query field "${name}" on type "PullRequestFile".`);
    }
    case 'Commit': {
      if (name === 'oid') return parent.oid as string;
      throw new GQLError(`Cannot query field "${name}" on type "Commit".`);
    }
    case '__Type': {
      if (name === 'name') return parent.typeName as string;
      if (name === 'kind') return parent.kind as string;
      if (name === 'fields') {
        const fields = parent.fields as string[] | null;
        if (!fields) return null;
        return fields.map((f) => node('__Field', { name: f }));
      }
      if (name === 'enumValues') {
        const values = parent.enumValues as string[] | null;
        if (!values) return null;
        return values.map((v) => node('__EnumValue', { name: v }));
      }
      throw new GQLError(`Cannot query field "${name}" on type "__Type".`);
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return parent.name as string;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
    }
    case '__Schema': {
      if (name === 'types') return [];
      if (name === 'queryType') return node('__Type', { typeName: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: null });
      if (name === 'mutationType') return node('__Type', { typeName: 'Mutation', kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: null });
      throw new GQLError(`Cannot query field "${name}" on type "__Schema".`);
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = field.args.input as Record<string, GQLValue>;
        const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId && repoId.kind === 'Repository' ? ctx.store.reposById.get(repoId.id) : undefined;
        if (!repo) throw new GQLError('createIssue: repository not found');
        const result = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if (!result.issue) throw new GQLError(result.error ?? 'createIssue failed');
        return node('CreateIssuePayload', { issue: issueNode(ctx, repo, result.issue) });
      }
      if (name === 'closeIssue') {
        const input = field.args.input as Record<string, GQLValue>;
        const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
        if (!found) throw new GQLError('closeIssue: issue not found');
        found.issue.state = 'closed';
        return node('CloseIssuePayload', { issue: issueNode(ctx, found.repo, found.issue) });
      }
      if (name === 'createPullRequest') {
        const input = field.args.input as Record<string, GQLValue>;
        const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId && repoId.kind === 'Repository' ? ctx.store.reposById.get(repoId.id) : undefined;
        if (!repo) throw new GQLError('createPullRequest: repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
        if (existing) return node('CreatePullRequestPayload', { pullRequest: pullNode(ctx, repo, existing) });
        const result = ctx.store.createPull(repo, String(input.title ?? ''), '', headRef, baseRef);
        if (!result.pull) throw new GQLError(result.error ?? 'createPullRequest failed');
        return node('CreatePullRequestPayload', { pullRequest: pullNode(ctx, repo, result.pull) });
      }
      if (name === 'mergePullRequest') {
        const input = field.args.input as Record<string, GQLValue>;
        const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
        if (!found) throw new GQLError('mergePullRequest: pull request not found');
        const result = ctx.store.mergePull(found.repo, found.pull);
        if (!result.ok) throw new GQLError(result.error ?? 'mergePullRequest failed');
        return node('MergePullRequestPayload', { pullRequest: pullNode(ctx, found.repo, found.pull) });
      }
      if (name === 'addComment') {
        const input = field.args.input as Record<string, GQLValue>;
        const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
        if (!found) throw new GQLError('addComment: subject not found');
        found.repo.commentSeq += 1;
        const commentId = found.repo.id * 100000 + found.repo.commentSeq;
        const comment = { id: commentId, body: String(input.body ?? ''), createdSeq: 0 };
        const list = found.repo.comments.get(found.issue.number) ?? [];
        list.push(comment);
        found.repo.comments.set(found.issue.number, list);
        const commentNode = node('IssueComment', { id: encodeGlobalId('IssueComment', commentId), body: comment.body });
        return node('AddCommentPayload', { commentEdge: node('IssueCommentEdge', { node: commentNode }) });
      }
      throw new GQLError(`Cannot query field "${name}" on type "Mutation".`);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue as unknown;
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest as unknown;
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge as unknown;
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return parent.node as unknown;
      if (name === 'cursor') return encodeCursor(0);
      throw new GQLError(`Cannot query field "${name}" on type "IssueCommentEdge".`);
    }
    case 'IssueComment': {
      if (name === 'id') return parent.id as string;
      if (name === 'body') return parent.body as string;
      throw new GQLError(`Cannot query field "${name}" on type "IssueComment".`);
    }
    default:
      throw new GQLError(`Cannot query field "${name}" on type "${typeName}".`);
  }
}

function paginateIssues(ctx: Ctx, repo: Repo, list: Issue[], args: Record<string, GQLValue>): NodeValue {
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = decodeCursor(args.after as string | null);
  let start = 0;
  if (after !== null) {
    const idx = list.findIndex((i) => i.number === after);
    start = idx === -1 ? list.length : idx + 1;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return node('IssueConnection', {
    nodes: page.map((i) => issueNode(ctx, repo, i)),
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null },
  });
}

function paginatePulls(ctx: Ctx, repo: Repo, list: Pull[], args: Record<string, GQLValue>): NodeValue {
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = decodeCursor(args.after as string | null);
  let start = 0;
  if (after !== null) {
    const idx = list.findIndex((p) => p.number === after);
    start = idx === -1 ? list.length : idx + 1;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return node('PullRequestConnection', {
    nodes: page.map((p) => pullNode(ctx, repo, p)),
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null },
  });
}

function executeSelection(parent: NodeValue, fields: GQLField[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const value = resolveField(parent, field, ctx);
    out[key] = materialize(value, field.selection, ctx);
  }
  return out;
}

function materialize(value: unknown, selection: GQLField[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => materialize(v, selection, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (!selection) return value;
    return executeSelection(value as NodeValue, selection, ctx);
  }
  return value;
}

function executeOperation(op: GQLOperation, ctx: Ctx): Record<string, unknown> {
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root = node(rootType, {});
  return executeSelection(root, op.selection, ctx);
}

// ------------------------------------------------------------------ HTTP entry
export interface GraphQLResponse {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResponse {
  const ctx: Ctx = { store };
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!doc || typeof doc !== 'object') {
      return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const d = doc as Record<string, unknown>;
    const query = typeof d.query === 'string' ? d.query : '';
    const variables = (d.variables ?? {}) as Record<string, GQLValue>;
    const operationName = typeof d.operationName === 'string' ? d.operationName : null;
    try {
      const parser = new Parser(query, variables);
      const operations = parser.parseDocument();
      if (operations.length === 0) {
        return { data: null, errors: [{ message: 'No operation found' }] };
      }
      let op: GQLOperation | undefined;
      if (operationName) op = operations.find((o) => o.name === operationName);
      else op = operations[0];
      if (!op) {
        return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
      }
      const data = executeOperation(op, ctx);
      return { data };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: null, errors: [{ message }] };
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((doc) => runOne(doc)) };
  }
  return { status: 200, body: runOne(body) };
}
