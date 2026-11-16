// Entry point: the harness lifecycle for this forge.
// The trial environment (env) runs the contest: it publishes its own URL in
// MAKEFUN_ENV_URL, expects the forge to bind a port of its own choosing,
// learn that port through POST /register, and keep serving until GET /done
// reports the trial is finished. Nothing else is asked of this file — the
// whole GitHub-compatible surface lives in app.ts — so the only job here is
// to run that handshake faithfully and get out of the way:
//   * without MAKEFUN_ENV_URL there is no env to talk to: bail out at once;
//   * bind port 0 and let the kernel pick a free one (never 8080 — the env
//     listens there);
//   * register the chosen port; the first registration wins, and a 409 only
//     means some other entry got there first, so this process waits like any
//     other;
//   * poll /done with a short exponential backoff until it says done;
//   * shut the server down and exit 0.
// Every request goes out through fetch with a per-request timeout, and every
// failed attempt is retried — the env may still be starting when this process
// boots, and this process must never exit before the env says done.

import { createApp } from './app.ts';

// --- knobs ---------------------------------------------------------------

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
const BACKOFF_GROWTH = 2;
const BACKOFF_MAX_STEP = 8;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * BACKOFF_GROWTH ** Math.min(failures, BACKOFF_MAX_STEP));

// --- talking to the env --------------------------------------------------

class ContractError extends Error {}

async function registerWithEnv(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    let response: Response | null = null;
    try {
      response = await fetch(`${ENV_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      // Env unreachable or the request timed out — wait and try again.
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new ContractError(`registration rejected with HTTP ${response.status}: ${await response.text()}`);
      }
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function waitUntilDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Env not answering yet — keep polling.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// --- startup -------------------------------------------------------------

async function serve(): Promise<void> {
  const app = createApp();
  await new Promise<void>((ok, fail) => {
    app.once('error', fail);
    app.listen(0, ok);
  });
  const bound = app.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server failed to bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerWithEnv(bound.port);
  process.stdout.write('[entry] registered with env; polling for done\n');

  await waitUntilDone();
  app.close();
  process.stdout.write('[entry] env said done; shutting down\n');
}

serve().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
