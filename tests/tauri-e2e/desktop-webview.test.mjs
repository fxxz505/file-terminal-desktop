import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const driverUrl = (process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const appPath = process.env.TAURI_E2E_APP;
const artifacts = process.env.TAURI_E2E_ARTIFACTS ?? 'e2e-artifacts';

async function request(path, init = {}) {
  const response = await fetch(`${driverUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.value?.error) {
    throw new Error(body.value?.message ?? `WebDriver ${response.status} ${path}`);
  }
  return body.value;
}

async function requestWithRetry(path, init = {}, timeoutMs = 60_000) {
  let attempts = 0;
  return eventually(async () => {
    attempts += 1;
    try {
      return await request(path, init);
    } catch (error) {
      if (path === '/session' && attempts % 10 === 0) console.error(`WebDriver session attempt ${attempts}: ${error.message}`);
      throw error;
    }
  }, timeoutMs);
}

async function eventually(action, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await action(); } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw lastError ?? new Error('Timed out waiting for WebView state');
}

test('real Tauri WebView navigates between local search, diagnostics, and task center', { timeout: 120_000 }, async (t) => {
  assert.ok(appPath, 'TAURI_E2E_APP must point to the debug Tauri executable');
  const session = await requestWithRetry('/session', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: appPath },
        },
      },
    }),
  }, 90_000);
  const sessionId = session.sessionId;
  const base = `/session/${sessionId}`;
  t.after(async () => { await fetch(`${driverUrl}${base}`, { method: 'DELETE' }).catch(() => {}); });

  const find = selector => eventually(() => request(`${base}/element`, {
    method: 'POST',
    body: JSON.stringify({ using: 'css selector', value: selector }),
  }));
  const click = async selector => {
    const element = await find(selector);
    const id = element['element-6066-11e4-a52e-4f735466cecf'];
    await request(`${base}/element/${id}/click`, { method: 'POST', body: '{}' });
  };

  await click('[data-testid="nav-search"]');
  await find('[data-testid="search-question"]');
  await click('[data-testid="nav-diagnostics"]');
  await find('.diagnostics-page');
  await click('[data-testid="nav-tasks"]');
  await find('[data-testid="task-list"]');

  await mkdir(artifacts, { recursive: true });
  const screenshot = await request(`${base}/screenshot`);
  await writeFile(join(artifacts, 'tauri-navigation.png'), Buffer.from(screenshot, 'base64'));
});
