// app.ts — HTTP server: routing, Bearer auth, body parsing, JSON replies.
// One in-memory Store shared by git, REST, GraphQL and MCP.
// main.ts imports { createApp } from here and owns the lifecycle.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errorBody, handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  const payload = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const out: Record<string, string> = { ...headers };
  if (!out['content-type']) out['content-type'] = 'application/json; charset=utf-8';
  if (payload !== '') out['content-length'] = String(Buffer.byteLength(payload));
  res.writeHead(status, out);
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const pathname = url.pathname;
        const segments = pathname.split('/').filter((s) => s !== '');

        // Health check: no auth. The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, {}, { ok: true });
          return;
        }

        // Bearer auth for everything else.
        const auth = req.headers.authorization ?? '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        if (bearer === '' || (shopToken !== '' && bearer !== shopToken)) {
          const r = errorBody(401, 'Unauthorized');
          sendJson(res, r.status, r.headers, r.body);
          return;
        }

        const body = await readBody(req);
        const host = req.headers.host ?? '127.0.0.1';

        // ---------------------------------------------------------- REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          let parsedBody: unknown = undefined;
          if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              const r = errorBody(400, 'Invalid JSON');
              sendJson(res, r.status, r.headers, r.body);
              return;
            }
          }
          const r = handleRest(store, method, segments.slice(2), url.searchParams, parsedBody, host);
          if (r.status === 204) {
            res.writeHead(204, r.headers);
            res.end();
            return;
          }
          sendJson(res, r.status, r.headers, r.body);
          return;
        }

        // ---------------------------------------------------------- GraphQL
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            const r = errorBody(405, 'Method Not Allowed');
            sendJson(res, r.status, r.headers, r.body);
            return;
          }
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            const r = errorBody(400, 'Invalid JSON');
            sendJson(res, r.status, r.headers, r.body);
            return;
          }
          const r = handleGraphQL(store, parsedBody);
          const headers = { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-gql-${Date.now().toString(36)}` };
          sendJson(res, r.status, headers, r.body);
          return;
        }

        // ---------------------------------------------------------- MCP
        if (segments[0] === 'mcp') {
          if (method !== 'POST') {
            const r = errorBody(405, 'Method Not Allowed');
            sendJson(res, r.status, r.headers, r.body);
            return;
          }
          let parsedBody: unknown = undefined;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { 'content-type': 'application/json; charset=utf-8' }, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
              return;
            }
          }
          const r = handleMcp(store, parsedBody);
          if (r.status === 202 || r.body === null) {
            res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            res.end();
            return;
          }
          sendJson(res, r.status, { 'content-type': 'application/json; charset=utf-8' }, r.body);
          return;
        }

        // ---------------------------------------------------------- git smart HTTP
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -'.git'.length));
          const repo = store.findRepo(owner, repoName);
          const rest = segments.slice(2);
          if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
            if (method !== 'GET') {
              const r = errorBody(405, 'Method Not Allowed');
              sendJson(res, r.status, r.headers, r.body);
              return;
            }
            const service = url.searchParams.get('service') ?? '';
            const gitProtocol = req.headers['git-protocol'] ?? '';
            const r = handleInfoRefs(repo, service, gitProtocol);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          if (rest.length === 1 && rest[0] === 'git-upload-pack') {
            if (method !== 'POST') {
              const r = errorBody(405, 'Method Not Allowed');
              sendJson(res, r.status, r.headers, r.body);
              return;
            }
            const r = handleUploadPack(repo, body);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          if (rest.length === 1 && rest[0] === 'git-receive-pack') {
            if (method !== 'POST') {
              const r = errorBody(405, 'Method Not Allowed');
              sendJson(res, r.status, r.headers, r.body);
              return;
            }
            const r = handleReceivePack(repo, body);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          const r = errorBody(404, 'Not Found');
          sendJson(res, r.status, r.headers, r.body);
          return;
        }

        // ---------------------------------------------------------- unknown route
        const r = errorBody(404, 'Not Found');
        sendJson(res, r.status, r.headers, r.body);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          sendJson(res, 500, { 'content-type': 'application/json; charset=utf-8' }, { message: `Internal error: ${message}` });
        } catch {
          // Response already gone; nothing to do.
        }
      }
    })();
  });
  return server;
}
