// rest.ts — REST v3 (/api/v3): repos, branches, commits, refs, contents,
// issues, labels, pulls. All responses are JSON with X-GitHub-Request-Id.
import {
  ZERO_OID,
  buildTreesFromFiles,
  parseTag,
  type GitObject,
} from './gitutil.ts';
import {
  countLines,
  diffMaps,
  lineDiff,
  resolveRef,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown; // JSON value, or null for 204
}

let requestCounter = 0;

export function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  requestCounter += 1;
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${requestCounter.toString(16)}-${Date.now().toString(36)}`,
      ...extraHeaders,
    },
    body,
  };
}

export function errorBody(status: number, message: string): RestResponse {
  return json(status, { message });
}

function viewerLogin(store: Store): string {
  return store.viewerLogin ?? 'viewer';
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const login = viewerLogin(store);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${login}/${repo.name}`,
    url: `/repos/${login}/${repo.name}`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const login = viewerLogin(store);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: repo.id * 1000 + name.length, name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login, id: repo.id, type: 'User' },
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null,
    html_url: `https://github.com/${login}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${login}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const login = viewerLogin(store);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { label: `${login}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login, type: 'User' }, repo: { name: repo.name } },
    base: { label: `${login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login, type: 'User' }, repo: { name: repo.name } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.mergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: pull.merged ? 'clean' : 'clean',
    user: { login, id: repo.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: pull.state === 'closed' ? '2025-01-01T00:00:00Z' : null,
    html_url: `https://github.com/${login}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${login}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const info = repo.commitInfo(sha);
  if (!info) return null;
  return {
    sha,
    commit: {
      message: info.message,
      author: { name: 'Forge', email: 'forge@make.fun', date: '2025-01-01T00:00:00Z' },
      committer: { name: 'Forge', email: 'forge@make.fun', date: '2025-01-01T00:00:00Z' },
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
    author: { login: 'forge', type: 'User' },
    committer: { login: 'forge', type: 'User' },
    url: `/repos/${repo.name}/commits/${sha}`,
  };
}

/** List commits reachable from a tip, newest first (first-parent walk + all parents). */
function listCommits(repo: Repo, tip: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    const info = repo.commitInfo(oid);
    if (!info) continue;
    const c = commitJson(repo, oid);
    if (c) out.push(c);
    for (const p of info.parents) stack.push(p);
  }
  return out;
}

function parseIssueNumber(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function labelNamesFromBody(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const labels = (body as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const l of labels) {
    if (typeof l === 'string') names.push(l);
    else if (l && typeof l === 'object' && typeof (l as Record<string, unknown>).name === 'string') {
      names.push((l as Record<string, unknown>).name as string);
    }
  }
  return names;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): RestResponse {
  const seg = segments;
  // GET /api/v3/ (root)
  if (seg.length === 0) {
    if (method !== 'GET') return errorBody(404, 'Not Found');
    return json(200, {
      current_user_url: '/user',
      rate_limit_url: '/rate_limit',
      repository_url: '/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta') {
    if (method !== 'GET') return errorBody(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return errorBody(404, 'Not Found');
      const login = viewerLogin(store);
      return json(200, { login, id: 1, type: 'User', name: login, avatar_url: '', html_url: `https://github.com/${login}` });
    }
    if (seg[1] === 'repos') {
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = typeof b.name === 'string' ? b.name : '';
        if (name === '') return errorBody(422, 'Repository name is required');
        const repo = store.createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
        if (!repo) return errorBody(422, `Repository ${name} already exists`);
        return json(201, repoJson(store, repo));
      }
      if (method === 'GET') {
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const all = store.listRepos();
        const totalPages = Math.max(1, Math.ceil(all.length / perPage));
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
        const links: string[] = [];
        if (page < totalPages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
        if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
        links.push(`<${base}&page=1>; rel="first"`);
        links.push(`<${base}&page=${totalPages}>; rel="last"`);
        return json(200, slice.map((r) => repoJson(store, r)), { link: links.join(', ') });
      }
      return errorBody(404, 'Not Found');
    }
    return errorBody(404, 'Not Found');
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]);
    const repoName = decodeURIComponent(seg[2]);
    const rest = seg.slice(3);
    const repo = store.findRepo(owner, repoName);
    // Repo itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return errorBody(404, 'Repository not found');
        return json(200, repoJson(store, repo));
      }
      if (method === 'PATCH') {
        if (!repo) return errorBody(404, 'Repository not found');
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        return json(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        if (!repo) return errorBody(404, 'Repository not found');
        store.reposByName.delete(repo.name);
        store.reposById.delete(repo.id);
        return { status: 204, headers: { 'x-github-request-id': `req-${(requestCounter += 1).toString(16)}` }, body: null };
      }
      return errorBody(404, 'Not Found');
    }
    if (!repo) return errorBody(404, 'Repository not found');
    const sub = rest[0];
    // ---------------------------------------------------------- branches
    if (sub === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return errorBody(404, 'Not Found');
        const out = repo.allRefs()
          .filter((r) => r.name.startsWith('refs/heads/'))
          .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid, url: '' }, protected: false }));
        return json(200, out);
      }
      const branch = rest.slice(1).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (method === 'GET') {
        if (!tip) return errorBody(404, 'Branch not found');
        return json(200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
      }
      return errorBody(404, 'Not Found');
    }
    // ---------------------------------------------------------- commits
    if (sub === 'commits') {
      if (method !== 'GET') return errorBody(404, 'Not Found');
      const shaParam = query.get('sha');
      const tip = shaParam ? resolveRef(repo, shaParam) : repo.headOid();
      if (!tip) return errorBody(404, 'No commits');
      return json(200, listCommits(repo, tip));
    }
    // ---------------------------------------------------------- git/refs
    if (sub === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const ref = typeof b.ref === 'string' ? b.ref : '';
          const sha = typeof b.sha === 'string' ? b.sha : '';
          if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return errorBody(422, 'Invalid ref or sha');
          if (repo.refs.has(ref)) return errorBody(422, 'Reference already exists');
          repo.refs.set(ref, sha);
          return json(201, { ref, object: { sha, type: 'commit', url: '' }, url: '' });
        }
        return errorBody(404, 'Not Found');
      }
      if (method === 'GET') {
        const ref = rest.slice(2).join('/');
        const fullRef = `refs/${ref}`;
        const oid = repo.refs.get(fullRef);
        if (!oid) return errorBody(404, 'Reference not found');
        return json(200, { ref: fullRef, object: { sha: oid, type: 'commit', url: '' }, url: '' });
      }
      return errorBody(404, 'Not Found');
    }
    // ---------------------------------------------------------- contents
    if (sub === 'contents') {
      const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = resolveRef(repo, ref);
        if (!tip) return errorBody(404, 'Repository is empty');
        const files = repo.flattenTree(repo.treeOf(tip));
        const direct = files.get(path);
        if (direct) {
          const obj = repo.objects.get(direct.oid);
          const data: Buffer = obj ? obj.data : Buffer.alloc(0);
          return json(200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: direct.oid,
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
            url: '',
            html_url: '',
            download_url: '',
          });
        }
        // Directory listing.
        const prefix = path === '' ? '' : `${path}/`;
        const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
        for (const [p, f] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (!first) continue;
          if (restPath.includes('/')) {
            if (!entries.has(first)) {
              // Real subtree oid for the directory entry.
              const subFiles = new Map<string, { mode: string; oid: string }>();
              for (const [sp, sf] of files) {
                if (sp.startsWith(`${prefix}${first}/`)) subFiles.set(sp.slice(`${prefix}${first}/`.length), sf);
              }
              const { rootOid } = buildTreesFromFiles(subFiles);
              entries.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: rootOid, size: 0 });
            }
          } else {
            const obj = repo.objects.get(f.oid);
            entries.set(first, { type: 'file', name: first, path: p, sha: f.oid, size: obj ? obj.data.length : 0 });
          }
        }
        if (entries.size === 0) return errorBody(404, 'Not Found');
        const sorted = [...entries.values()].sort((a, c) => (a.name < c.name ? -1 : 1));
        return json(200, sorted);
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : `Update ${path}`;
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (contentB64 === '') return errorBody(400, 'content is required');
        const data = Buffer.from(contentB64, 'base64');
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        let tip = repo.refs.get(branchRef);
        if (!tip && repo.refs.size > 0) return errorBody(404, 'Branch not found');
        const files = tip ? repo.flattenTree(repo.treeOf(tip)) : new Map<string, { mode: string; oid: string }>();
        const existing = files.get(path);
        const shaParam = typeof b.sha === 'string' ? b.sha : undefined;
        if (shaParam !== undefined) {
          if (!existing || existing.oid !== shaParam) return errorBody(409, 'sha does not match the current file');
        }
        const blobOid = repo.putObject('blob', data);
        files.set(path, { mode: '100644', oid: blobOid });
        const commitOid = repo.commitFiles(branch, files, message);
        return json(existing ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file', url: '', html_url: '' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const message = typeof b.message === 'string' ? b.message : `Delete ${path}`;
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return errorBody(404, 'Branch not found');
        const files = repo.flattenTree(repo.treeOf(tip));
        const existing = files.get(path);
        if (!existing) return errorBody(404, 'Not Found');
        const shaParam = typeof b.sha === 'string' ? b.sha : undefined;
        if (shaParam !== undefined && existing.oid !== shaParam) return errorBody(409, 'sha does not match the current file');
        files.delete(path);
        const commitOid = repo.commitFiles(branch, files, message);
        return json(200, { commit: { sha: commitOid, message }, content: null });
      }
      return errorBody(404, 'Not Found');
    }
    // ---------------------------------------------------------- labels
    if (sub === 'labels') {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((l) => ({ id: repo.id, name: l.name, color: l.color, description: '', default: false })));
      }
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
        if (name === '') return errorBody(422, 'Label name is required');
        const existing = repo.labels.get(name);
        if (existing) return json(200, { id: repo.id, name, color: existing.color, description: '', default: false });
        repo.labels.set(name, { name, color });
        return json(201, { id: repo.id, name, color, description: '', default: false });
      }
      return errorBody(404, 'Not Found');
    }
    // ---------------------------------------------------------- issues
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          if (title === '') return errorBody(422, 'Title is required');
          const result = store.createIssue(repo, title, bodyText, labelNamesFromBody(body));
          if (!result.issue) return errorBody(422, result.error ?? 'Invalid labels');
          return json(201, issueJson(store, repo, result.issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, c) => (direction === 'asc' ? a.number - c.number : c.number - a.number));
          return json(200, list.map((i) => issueJson(store, repo, i)));
        }
        return errorBody(404, 'Not Found');
      }
      const num = parseIssueNumber(rest[1]);
      if (num === null) return errorBody(404, 'Not Found');
      const issue = repo.issues.get(num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return errorBody(404, 'Issue not found');
          return json(200, issueJson(store, repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return errorBody(404, 'Issue not found');
          const b = (body ?? {}) as Record<string, unknown>;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const names = labelNamesFromBody(body);
            for (const name of names) {
              if (!repo.labels.has(name)) return errorBody(422, `Label '${name}' does not exist`);
            }
            issue.labels = names;
          }
          return json(200, issueJson(store, repo, issue));
        }
        return errorBody(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          if (!issue) return errorBody(404, 'Issue not found');
          const comments = repo.comments.get(num) ?? [];
          return json(200, comments.map((c) => ({
            id: c.id, body: c.body, user: { login: viewerLogin(store), type: 'User' },
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          })));
        }
        if (method === 'POST') {
          if (!issue) return errorBody(404, 'Issue not found');
          const b = (body ?? {}) as Record<string, unknown>;
          const bodyText = typeof b.body === 'string' ? b.body : '';
          repo.commentSeq += 1;
          const comment = { id: repo.id * 100000 + repo.commentSeq, body: bodyText, createdSeq: 0 };
          const list = repo.comments.get(num) ?? [];
          list.push(comment);
          repo.comments.set(num, list);
          return json(201, {
            id: comment.id, body: comment.body, user: { login: viewerLogin(store), type: 'User' },
            created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          });
        }
        return errorBody(404, 'Not Found');
      }
      return errorBody(404, 'Not Found');
    }
    // ---------------------------------------------------------- pulls
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : '';
          if (title === '' || head === '' || base === '') return errorBody(422, 'title, head and base are required');
          const result = store.createPull(repo, title, bodyText, head, base);
          if (!result.pull) return errorBody(422, result.error ?? 'Cannot create pull request');
          return json(201, pullJson(store, repo, result.pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.number - a.number);
          return json(200, list.map((p) => pullJson(store, repo, p)));
        }
        return errorBody(404, 'Not Found');
      }
      const num = parseIssueNumber(rest[1]);
      if (num === null) return errorBody(404, 'Not Found');
      const pull = repo.pulls.get(num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return errorBody(404, 'Pull request not found');
          return json(200, pullJson(store, repo, pull));
        }
        return errorBody(404, 'Not Found');
      }
      if (rest[2] === 'files') {
        if (method !== 'GET') return errorBody(404, 'Not Found');
        if (!pull) return errorBody(404, 'Pull request not found');
        const base = repo.mergeBase(pull.headSha, pull.baseSha);
        const ancestorFiles = base ? repo.flattenTree(repo.treeOf(base)) : new Map<string, { mode: string; oid: string }>();
        const headFiles = repo.flattenTree(repo.treeOf(pull.headSha));
        const changes = diffMaps(ancestorFiles, headFiles);
        const out: Record<string, unknown>[] = [];
        for (const change of [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
          let additions = 0;
          let deletions = 0;
          if (change.status === 'added') {
            const obj = change.newOid ? repo.objects.get(change.newOid) : undefined;
            additions = obj ? countLines(obj.data) : 0;
          } else if (change.status === 'removed') {
            const obj = change.oldOid ? repo.objects.get(change.oldOid) : undefined;
            deletions = obj ? countLines(obj.data) : 0;
          } else {
            const oldObj = change.oldOid ? repo.objects.get(change.oldOid) : undefined;
            const newObj = change.newOid ? repo.objects.get(change.newOid) : undefined;
            const d = lineDiff(oldObj ? oldObj.data : Buffer.alloc(0), newObj ? newObj.data : Buffer.alloc(0));
            additions = d.additions;
            deletions = d.deletions;
          }
          out.push({
            filename: change.path,
            status: change.status,
            additions,
            deletions,
            changes: additions + deletions,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          });
        }
        return json(200, out);
      }
      if (rest[2] === 'merge') {
        if (method !== 'PUT') return errorBody(404, 'Not Found');
        if (!pull) return errorBody(404, 'Pull request not found');
        const result = store.mergePull(repo, pull);
        if (!result.ok) return errorBody(result.status, result.error ?? 'Cannot merge');
        return json(200, { merged: true, sha: result.sha, message: `Pull request #${pull.number} merged` });
      }
      return errorBody(404, 'Not Found');
    }
    return errorBody(404, 'Not Found');
  }
  return errorBody(404, 'Not Found');
}

export { parseTag };
export type { GitObject };
