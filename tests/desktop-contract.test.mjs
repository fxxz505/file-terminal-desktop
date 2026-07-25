import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop application declares a Tauri window and local data backend', async () => {
  const config = await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.match(config, /"productName": "资料终端"/);
  assert.match(config, /"frontendDist": "\.\.\/dist"/);
  assert.match(cargo, /rusqlite/);
  assert.match(cargo, /reqwest/);
});

test('desktop shell exposes native model download and grounded assistant commands', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(source, /fn download_model/);
  assert.match(source, /fn ask_assistant/);
  assert.match(source, /fn import_folder/);
});

test('Windows release starts without a console window', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(source, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/);
});

test('assistant contract includes a deterministic fallback for game intent', async () => {
  const source = await readFile(new URL('../src-tauri/src/assistant.rs', import.meta.url), 'utf8');
  assert.match(source, /normalized\.contains\("游戏"\) \|\| normalized\.contains\("玩"\)/);
  assert.match(source, /"steam"/);
});

test('native assistant uses the bundled runtime only after it is available', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(source, /llama-cli\.exe/);
  assert.match(source, /unwrap_or_else\(\|\| extract_search_terms\(question\)\)/);
});

test('desktop capability allows the frontend to receive download progress events', async () => {
  const capability = await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8');
  assert.match(capability, /core:event:default/);
});

test('sidebar navigation controls real workspace, search, and assistant views', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /data-view="workspace"/);
  assert.match(source, /data-view="search"/);
  assert.match(source, /data-view="assistant"/);
  assert.match(source, /activeView/);
  assert.match(source, /\[data-view\]/);
});

test('model status badges occupy their own grid row rather than the action column', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.setup-state\{grid-column:2;grid-row:2/);
  assert.match(styles, /\.setup-button\{grid-column:3;grid-row:1\/3/);
});

test('desktop updater verifies signed GitHub release updates before installation', async () => {
  const config = await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
  const capability = await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(config, /createUpdaterArtifacts/);
  assert.match(config, /github\.com\/fxxz505\/file-terminal-desktop\/releases\/latest\/download\/latest\.json/);
  assert.match(capability, /updater:default/);
  assert.match(capability, /process:default/);
  assert.match(shell, /downloadAndInstall/);
  assert.match(shell, /relaunch/);
  assert.match(backend, /tauri_plugin_updater/);
});
