import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const driverUrl = (process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const nativeDriverUrl = (process.env.TAURI_NATIVE_DRIVER_URL ?? '').replace(/\/$/, '');
const appPath = process.env.TAURI_E2E_APP;
const artifacts = process.env.TAURI_E2E_ARTIFACTS ?? 'e2e-artifacts';
const webviewProfile = process.env.TAURI_WEBVIEW_PROFILE;

async function request(path, init = {}, baseUrl = driverUrl) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.value?.error) {
    throw new Error(body.value?.message ?? `WebDriver ${response.status} ${path}`);
  }
  return body.value;
}

async function requestWithRetry(path, init = {}, timeoutMs = 60_000, baseUrl = driverUrl) {
  let attempts = 0;
  return eventually(async () => {
    attempts += 1;
    try {
      return await request(path, init, baseUrl);
    } catch (error) {
      if (path === '/session' && attempts % 10 === 0) {
        console.error(`WebDriver session attempt ${attempts}: ${error.message}`);
        if (error?.cause) console.error('WebDriver session cause:', error.cause);
      }
      throw error;
    }
  }, timeoutMs);
}

function nativeSessionRequest() {
  const body = JSON.stringify({ capabilities: { alwaysMatch: {
    browserName: 'webview2',
    'ms:edgeChromium': true,
    'ms:edgeOptions': {
      binary: appPath,
      ...(webviewProfile ? { webviewOptions: { userDataFolder: webviewProfile } } : {}),
    },
  } } });
  return requestWithRetry('/session', { method: 'POST', body }, 90_000, nativeDriverUrl);
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
  let sessionBaseUrl = driverUrl;
  let session;
  try {
    session = await requestWithRetry('/session', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          'tauri:options': {
            application: appPath,
            ...(webviewProfile ? { webviewOptions: { userDataFolder: webviewProfile } } : {}),
          },
        },
      },
    }),
    }, 30_000);
  } catch (error) {
    if (nativeDriverUrl) {
      console.error(`Tauri driver session unavailable; native driver diagnostics are available at ${nativeDriverUrl}`);
    }
    throw error;
  }
  const sessionId = session.sessionId;
  const base = `/session/${sessionId}`;
  t.after(async () => { await fetch(`${sessionBaseUrl}${base}`, { method: 'DELETE' }).catch(() => {}); });

  const find = selector => eventually(() => request(`${base}/element`, {
    method: 'POST',
    body: JSON.stringify({ using: 'css selector', value: selector }),
  }, sessionBaseUrl));
  const click = async selector => {
    const element = await find(selector);
    const id = element['element-6066-11e4-a52e-4f735466cecf'];
    await request(`${base}/element/${id}/click`, { method: 'POST', body: '{}' }, sessionBaseUrl);
  };

  await click('[data-testid="nav-search"]');
  await find('[data-testid="search-question"]');
  await click('[data-testid="nav-diagnostics"]');
  await find('.diagnostics-page');
  await click('[data-testid="nav-tasks"]');
  await find('[data-testid="task-list"]');

  await mkdir(artifacts, { recursive: true });
  const screenshot = await request(`${base}/screenshot`, {}, sessionBaseUrl);
  await writeFile(join(artifacts, 'tauri-navigation.png'), Buffer.from(screenshot, 'base64'));
});
