// mcp.ts — MCP (Model Context Protocol) over Streamable HTTP at /mcp.
// Modern era (2026-07-28): server/discover, no handshake, no session.
// Legacy era (2025-11-25 and earlier): initialize + notifications/initialized.
import { type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const login = store.viewerLogin ?? 'viewer';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${login}/${repo.name}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  const login = store.viewerLogin ?? 'viewer';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login, type: 'User' },
    html_url: `https://github.com/${login}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null }): Record<string, unknown> {
  const login = store.viewerLogin ?? 'viewer';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login, type: 'User' },
    html_url: `https://github.com/${login}/${repo.name}/pull/${pull.number}`,
  };
}

function findRepo(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return store.findRepo(owner, repo);
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  // Match by exact name, or by suffix (a server prefix such as github__create_issue).
  const tool = TOOLS.find((t) => t.name === name || name.endsWith(`__${t.name}`) || name.endsWith(t.name));
  if (!tool) {
    return { __jsonRpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
  const canonical = tool.name;
  // Required-argument check.
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  if (canonical === 'create_repo') {
    const repoName = String(args.name);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(repoName, description, isPrivate);
    if (!repo) return toolError(`Repository ${repoName} already exists`);
    return toolResult(repoJson(store, repo));
  }
  if (canonical === 'get_repo') {
    const repo = findRepo(store, args.owner, args.repo);
    if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
    return toolResult(repoJson(store, repo));
  }
  if (canonical === 'create_issue') {
    const repo = findRepo(store, args.owner, args.repo);
    if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
    const result = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    if (!result.issue) return toolError(result.error ?? 'Cannot create issue');
    return toolResult(issueJson(store, repo, result.issue));
  }
  if (canonical === 'list_issues') {
    const repo = findRepo(store, args.owner, args.repo);
    if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    const out = list.map((i) => issueJson(store, repo, i));
    return toolResult(out);
  }
  if (canonical === 'create_pull_request') {
    const repo = findRepo(store, args.owner, args.repo);
    if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
    const result = store.createPull(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      String(args.head),
      String(args.base),
    );
    if (!result.pull) return toolError(result.error ?? 'Cannot create pull request');
    return toolResult(pullJson(store, repo, result.pull));
  }
  if (canonical === 'merge_pull_request') {
    const repo = findRepo(store, args.owner, args.repo);
    if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (!pull) return toolError(`Pull request #${String(args.pull_number)} not found`);
    const result = store.mergePull(repo, pull);
    if (!result.ok) return toolError(result.error ?? 'Cannot merge pull request');
    return toolResult({ merged: true, sha: result.sha, number: pull.number, state: pull.state });
  }
  return toolError(`Unknown tool: ${name}`);
}

export interface McpResponse {
  status: number;
  body: unknown;
}

export function handleMcp(store: Store, body: unknown): McpResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications have no id and expect no response body.
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (id === undefined || id === null) {
    // A request without an id is a notification; nothing to answer.
    return { status: 202, body: null };
  }
  const result = (r: Record<string, unknown>): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: r },
  });
  const error = (code: number, message: string): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = LEGACY_REVISIONS.includes(offered) ? offered : '2025-11-25';
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, name, args);
    if ('__jsonRpcError' in outcome) {
      const e = outcome.__jsonRpcError as { code: number; message: string };
      return error(e.code, e.message);
    }
    return result(outcome);
  }
  return error(-32601, `Method not found: ${method}`);
}
