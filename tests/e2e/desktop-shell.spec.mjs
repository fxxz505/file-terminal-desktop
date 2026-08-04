import { test, expect } from '@playwright/test';

async function installTauriMock(page) {
  await page.addInitScript(() => {
    const empty = [];
    const defaults = {
      get_startup_mode: { recoveryRequired: false, dataDirectory: '', recoveryDirectory: '' },
      get_data_directory_status: { path: '', source: 'portable', portableAvailable: true, restartRequired: false },
      get_runtime_status: { modelInstalled: false, runtimeInstalled: false, modelPath: '', activeModelName: 'Test' },
      list_folder_refs: empty, list_conversations: empty, list_sensitive_rules: empty,
      list_local_models: [{ id: 'local-1', displayName: 'Qwen 本地测试模型', path: 'D:/models/qwen.gguf', active: true }],
      list_index_jobs: empty, list_embedding_models: empty, list_media_tasks: empty, list_managed_download_resources: empty,
      list_index_diagnostics: empty, list_background_tasks: empty,
      list_download_tasks: empty, list_folder_watch_status: empty,
      list_cloud_providers: [{ providerId: 'cloud-1', displayName: '测试云端', baseUrl: 'https://example.test', model: 'test-model', autoCollaboration: false, reviewEachRequest: false, configured: true }],
      get_cloud_provider_config: { providerId: 'cloud-1', displayName: '测试云端', baseUrl: 'https://example.test', model: 'test-model', autoCollaboration: false, reviewEachRequest: false, configured: true }, get_agent_preferences: { autoApplyLowRisk: false },
      get_privacy_status: { databaseEncrypted: true, message: 'test', recommendation: '' },
      get_startup_recovery_notice: null, get_runtime_settings: { executionMode: 'auto', threads: 4, contextSize: 4096 },
      get_media_settings: { whisperModelPath: '', ocrLanguage: 'chi_sim+eng' },
      get_local_tool_status: { pdfText: true, ffmpeg: false, ocr: false, transcription: false, officeConverter: false },
    };
    let callbackId = 10;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => callbackId++,
      unregisterCallback: () => {},
      convertFileSrc: path => path,
      invoke: async (command) => {
        const name = String(command).includes('|') ? String(command).split('|').pop() : command;
        if (name === 'register_listener' || name === 'listen') return callbackId++;
        if (Object.prototype.hasOwnProperty.call(defaults, name)) return defaults[name];
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto('/');
  await expect(page.locator('[data-testid="nav-workspace"]')).toBeVisible();
});

test('navigates across core desktop views', async ({ page }) => {
  await page.locator('[data-testid="nav-search"]').click();
  await expect(page.locator('[data-testid="search-question"]')).toBeVisible();
  await page.locator('[data-testid="nav-diagnostics"]').click();
  await expect(page.locator('.diagnostics-page')).toBeVisible();
  await page.locator('[data-testid="nav-assistant"]').click();
  await expect(page.locator('.assistant-workbench')).toBeVisible();
  await page.locator('[data-testid="nav-settings"]').click();
  await expect(page.locator('[data-testid="nav-settings"]')).toHaveClass(/active/);
});

test('exposes upload drop zone and file chooser entry point', async ({ page }) => {
  await expect(page.locator('#file-upload-drop')).toBeVisible();
  await expect(page.locator('[data-import-files]')).toBeVisible();
});

test('shows a centered AI workbench with local and cloud model choices and a right inspector', async ({ page }) => {
  await page.locator('[data-testid="nav-assistant"]').click();
  await expect(page.locator('.assistant-shell')).toBeVisible();
  await expect(page.locator('.assistant-history')).toBeVisible();
  await expect(page.locator('.assistant-history-new')).toContainText('新建对话');
  await expect(page.locator('.assistant-history-section')).toContainText('对话');
  await expect(page.locator('#assistant-model-choice')).toBeVisible();
  await expect(page.locator('#assistant-model-choice optgroup[label="本地模型"]')).toBeAttached();
  await expect(page.locator('#assistant-model-choice optgroup[label="云端模型"]')).toBeAttached();
  await expect(page.locator('.right-inspector')).toContainText('在此查看文件');
});
