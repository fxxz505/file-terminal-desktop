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

test('model download retries a verified mirror when the official Hugging Face request fails', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /MODEL_URLS/);
  assert.match(backend, /hf-mirror\.com/);
  assert.match(backend, /MODEL_SHA256/);
  assert.match(backend, /download_with_fallback/);
  assert.match(backend, /Sha256/);
  assert.match(shell, /progress\.source/);
});

test('metadata editing preserves notes and tags while showing fixed cloud policy labels', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /enum CloudPolicy/);
  assert.match(backend, /fn update_metadata/);
  assert.match(backend, /cloud_policy/);
  assert.match(backend, /metadata_audit/);
  assert.match(shell, /contextmenu/);
  assert.match(shell, /editMetadata/);
  assert.match(shell, /云端：禁止上传/);
});

test('AI output uses an explicitly selected folder or a dedicated application folder', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn prepare_ai_output/);
  assert.match(backend, /fn write_ai_file/);
  assert.match(backend, /ai_output_roots/);
  assert.match(backend, /safe_relative_path/);
  assert.match(shell, /选择 AI 写入文件夹/);
  assert.match(shell, /prepare_ai_output/);
});

test('workspace loads and displays each imported folder reference', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn list_folder_refs/);
  assert.match(backend, /COUNT\(index_items\.id\)/);
  assert.match(backend, /list_folder_refs/);
  assert.match(shell, /folderRefs/);
  assert.match(shell, /loadFolderRefs/);
  assert.match(shell, /imported-folders/);
});

test('imported folders use readable Windows paths and open in the inline browser', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn display_path/);
  assert.match(backend, /fn list_folder_children/);
  assert.match(backend, /display_path:/);
  assert.match(shell, /displayPath/);
  assert.match(shell, /openFolder/);
  assert.match(shell, /folder-browser/);
  assert.match(shell, /folder-ref-button/);
});

test('search results support safe local file previews and Explorer opening', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /fn preview_file/);
  assert.match(source, /fn reveal_in_explorer/);
  assert.match(source, /MAX_PREVIEW_BYTES/);
  assert.match(source, /tauri::generate_handler!\[[^\]]*preview_file[^\]]*reveal_in_explorer/s);
  assert.match(shell, /preview-file/);
  assert.match(shell, /file-preview/);
  assert.match(shell, /reveal_in_explorer/);
});

test('Windows release starts without a console window', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(source, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/);
});

test('an unreadable encrypted database opens a safe recovery-only shell instead of exiting', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /struct StartupMode/);
  assert.match(backend, /recovery_mode: bool/);
  assert.match(backend, /fn recovery_mode_connection/);
  assert.match(backend, /Connection::open_in_memory\(\)/);
  assert.match(backend, /fn get_startup_mode/);
  assert.match(backend, /fn reveal_recovery_data_directory/);
  assert.match(backend, /if !state\.recovery_mode/);
  assert.match(shell, /get_startup_mode/);
  assert.match(shell, /recoveryPage/);
  assert.match(shell, /reveal_recovery_data_directory/);
});

test('application data stays beside the executable and only copies legacy data forward', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /const DATA_LOCATION_POINTER_FILE/);
  assert.match(backend, /fn executable_data_dir/);
  assert.match(backend, /fn has_application_data/);
  assert.match(backend, /fn prepare_executable_data_dir/);
  assert.match(backend, /fn get_data_directory_status/);
  assert.match(backend, /copy_data_directory/);
  assert.match(shell, /get_data_directory_status/);
  const appDataStart = backend.indexOf('fn app_data_dir() -> Result<PathBuf, String> {');
  const appDataEnd = backend.indexOf('\n#[derive', appDataStart);
  const appDataDirectory = backend.slice(appDataStart, appDataEnd);
  assert.match(appDataDirectory, /prepare_executable_data_dir/);
  assert.doesNotMatch(appDataDirectory, /Ok\(default\)/);
  assert.doesNotMatch(shell, /choose-data-directory/);
});

test('recovery mode can preserve unreadable data and start a separate empty local database next to the executable', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(backend, /fn create_fresh_data_directory/);
  assert.match(backend, /fn start_fresh_database/);
  assert.match(backend, /资料终端数据-新建/);
  assert.match(backend, /fn executable_data_dir/);
  assert.match(backend, /资料终端数据/);
  assert.match(shell, /start_fresh_database/);
  assert.match(shell, /进入软件（新建资料库）/);
  assert.match(workflow, /Package portable bundle/);
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

test('diagnostics and background tasks provide compact, actionable empty states', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /diagnostic-empty/);
  assert.match(shell, /task-empty/);
  assert.match(shell, /data-view="workspace"/);
  assert.match(shell, /data-testid="task-list"/);
  assert.match(shell, /refresh-diagnostics/);
  assert.match(shell, /refresh-background-tasks/);
  assert.match(styles, /\.diagnostics-page,\.tasks-page\{min-height:0/);
  assert.match(styles, /\.diagnostic-empty,\.task-empty\{/);
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
  assert.match(config, /github\.com\/fxxz505\/file-terminal-desktop\/releases\/latest\/download\/latest\.json\?cache=\{\{current_version\}\}/);
  assert.match(capability, /updater:default/);
  assert.match(capability, /process:default/);
  assert.match(shell, /downloadAndInstall/);
  assert.match(shell, /relaunch/);
  assert.match(backend, /tauri_plugin_updater/);
});

test('release builds cache Rust artifacts while retaining signed updater publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /dtolnay\/rust-toolchain@stable/);
  assert.match(workflow, /Swatinem\/rust-cache@v2/);
  assert.match(workflow, /workspaces:\s*src-tauri\s*->\s*target/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /uploadUpdaterJson:\s*true/);
});

test('each supported branch push publishes a strictly newer signed in-app update', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches:\s*\['\*\*'\]/);
  assert.match(workflow, /GITHUB_RUN_NUMBER/);
  assert.match(workflow, /needs:\s*verify/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /uploadUpdaterJson:\s*true/);
  assert.match(workflow, /updaterJsonPreferNsis:\s*true/);
  assert.match(workflow, /Rewrite updater manifest with browser download URL/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /releases\/download/);
});

test('release versions stay aligned so the updater can detect a newer build', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lockJson = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const tauri = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.equal(packageJson.version, lockJson.version);
  assert.equal(packageJson.version, lockJson.packages[''].version);
  assert.equal(packageJson.version, tauri.version);
  assert.match(cargo, new RegExp(`version = "${packageJson.version}"`));
});

test('cloud collaboration keeps credentials outside SQLite and records only safe run metadata', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /struct CloudProviderConfig/);
  assert.match(backend, /fn save_cloud_provider_config/);
  assert.match(backend, /keyring::Entry/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS agent_runs/);
  assert.match(backend, /fn prepare_agent_run/);
  assert.match(backend, /async fn run_cloud_collaboration/);
  assert.match(backend, /数据库未保存原始问题或请求正文/);
  assert.doesNotMatch(backend, /api_key TEXT/);
});

test('cloud request preparation redacts sensitive text and respects local-only sources', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /fn redact_sensitive_text/);
  assert.match(backend, /CloudPolicy::LocalOnly/);
  assert.match(backend, /restrictedCapabilities/);
  assert.match(backend, /cloud_needs_confirmation/);
  assert.match(backend, /MAX_CLOUD_REQUEST_BYTES/);
});

test('assistant view exposes cloud settings, safe routing feedback, and a confirmation action', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /cloud-settings/);
  assert.match(shell, /save_cloud_provider_config/);
  assert.match(shell, /prepare_agent_run/);
  assert.match(shell, /run_cloud_collaboration/);
  assert.match(shell, /cloud-confirm/);
  assert.match(shell, /agentRun\.route === 'cloud_auto'/);
});

test('custom providers use temporary compatibility checks without persisting secrets', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn list_cloud_providers/);
  assert.match(backend, /struct CloudConnectionProbeInput/);
  assert.match(backend, /async fn test_cloud_connection/);
  assert.match(backend, /async fn discover_cloud_models/);
  assert.match(backend, /fn cloud_http_error_message/);
  assert.match(backend, /fn select_cloud_provider/);
  assert.match(backend, /\/v1\/models/);
  assert.match(backend, /cloud_provider_config/);
  assert.match(shell, /cloud-provider-form/);
  assert.match(shell, /test_cloud_connection/);
  assert.match(shell, /discover_cloud_models/);
  assert.match(shell, /select_cloud_provider/);
  assert.match(shell, /cloud-model-select/);
});

test('renaming a saved provider keeps its credential bound to the edited provider without storing secrets in SQLite', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /previous_provider_id/);
  assert.match(backend, /迁移云端提供商密钥/);
  assert.match(backend, /UPDATE cloud_provider_config SET provider_id/);
  assert.match(backend, /delete_credential/);
  assert.doesNotMatch(backend, /api_key TEXT/);
  assert.match(shell, /previousProviderId/);
  assert.match(shell, /cloudOriginalProviderId/);
});

test('cloud provider form hides the internal identifier and distinguishes saved credentials from temporary input', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /已保存到 Windows 凭据管理器/);
  assert.match(shell, /本次输入尚未保存/);
  assert.match(shell, /cloud-api-key-visibility/);
  assert.match(shell, /setAttribute\('aria-label'.*显示 API Key/);
  assert.match(shell, /crypto\.randomUUID/);
  assert.doesNotMatch(shell, /id="cloud-provider-id"/);
  assert.match(css, /cloud-provider-card/);
  assert.match(css, /cloud-secret-control/);
});

test('temporary connection checks keep the entered API key in the page and manual models remain valid', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /模型可在获取列表后再选择/);
  assert.match(backend, /模型列表不可用时也可以手动填写/);
  const discoveryHandler = shell.slice(shell.indexOf('async function fetchCloudModels'), shell.indexOf('async function selectCloudProvider'));
  assert.match(discoveryHandler, /discover_cloud_models/);
  assert.doesNotMatch(discoveryHandler, /save_cloud_provider_config/);
  assert.doesNotMatch(discoveryHandler, /cloudDraft = \{ \.\.\.draft, apiKey: '' \}/);
  assert.match(shell, /id="cloud-model-input"/);
  assert.match(backend, /model_endpoint_candidates/);
  assert.match(backend, /模型列表接口返回/);
});

test('local and cloud conversations are persisted and AI replies are parsed without executing them', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS conversations/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS conversation_messages/);
  assert.match(backend, /fn list_conversations/);
  assert.match(backend, /fn parse_ai_reply/);
  assert.match(backend, /fn save_conversation_message/);
  assert.match(shell, /conversation-history/);
  assert.match(shell, /parsedReply/);
  assert.doesNotMatch(shell, /innerHTML\s*=\s*.*parsedReply/);
});

test('agent advice can only write validated relative files inside an explicit workspace and run safe checks', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn extract_generated_files/);
  assert.match(backend, /fn apply_agent_advice/);
  assert.match(backend, /safe_relative_path/);
  assert.match(backend, /fn run_workspace_check/);
  assert.match(backend, /ALLOWED_WORKSPACE_CHECKS/);
  assert.match(shell, /apply-agent-advice/);
  assert.match(shell, /run-workspace-check/);
});

test('agent tasks expose cancellation and approval gates for non-read-only work', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn cancel_agent_run/);
  assert.match(backend, /fn approve_agent_step/);
  assert.match(backend, /awaiting_approval/);
  assert.match(shell, /cancel-agent-run/);
  assert.match(shell, /approve-agent-step/);
});

test('sensitive rules and saved data provide local governance controls', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS sensitive_rules/);
  assert.match(backend, /fn save_sensitive_rule/);
  assert.match(backend, /fn delete_cloud_provider/);
  assert.match(backend, /fn delete_conversation/);
  assert.match(shell, /sensitive-rule-form/);
  assert.match(shell, /delete-conversation/);
});

test('agent lifecycle persists step feedback, supports retry, and screens untrusted generated code', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS agent_events/);
  assert.match(backend, /fn list_agent_events/);
  assert.match(backend, /fn retry_agent_run/);
  assert.match(backend, /fn scan_generated_content/);
  assert.match(backend, /blocked_by_policy/);
  assert.match(shell, /retry-agent-run/);
  assert.match(shell, /agent-timeline/);
});

test('local data governance can export or clear records and indexing supports file content search', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE VIRTUAL TABLE IF NOT EXISTS index_content_fts/);
  assert.match(backend, /fn refresh_folder_index/);
  assert.match(backend, /fn export_local_governance/);
  assert.match(backend, /fn clear_local_data/);
  assert.match(backend, /fn summarize_source_for_cloud/);
  assert.match(shell, /export-local-governance/);
  assert.match(shell, /clear-local-data/);
});

test('folder refresh preserves metadata and users can choose an existing local GGUF model', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /existing_item_metadata/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS local_models/);
  assert.match(backend, /fn register_local_model/);
  assert.match(backend, /fn select_local_model/);
  assert.match(backend, /fn active_model_path/);
  assert.match(shell, /register-local-model/);
  assert.match(shell, /选择本地 GGUF 模型/);
});

test('cloud-bound source content is guarded against injection and local model records can be removed safely', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn contains_prompt_injection/);
  assert.match(backend, /提示词注入/);
  assert.match(backend, /fn delete_local_model/);
  assert.match(backend, /DELETE FROM local_models/);
  assert.match(shell, /delete-local-model/);
});

test('folder references can be safely removed and report missing source folders without touching originals', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn remove_folder_reference/);
  assert.match(backend, /DELETE FROM folder_refs/);
  assert.match(backend, /fn folder_reference_status/);
  assert.match(backend, /source_status/);
  assert.match(shell, /remove-folder-reference/);
  assert.match(shell, /sourceStatus/);
});

test('search has scoped pagination, stable filters, and source citations for assistant evidence', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /struct SearchDocumentsInput/);
  assert.match(backend, /fn search_documents/);
  assert.match(backend, /LIMIT \? OFFSET \?/);
  assert.match(backend, /struct SourceCitation/);
  assert.match(backend, /fn build_source_citations/);
  assert.match(shell, /search-filter/);
  assert.match(shell, /search-page-next/);
  assert.match(shell, /sourceCitations/);
});

test('indexing recognizes practical local document formats and reports per-reference progress', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn extract_document_text/);
  assert.match(backend, /docx|pptx|xlsx/);
  assert.match(backend, /index-progress/);
  assert.match(backend, /IndexProgress/);
  assert.match(shell, /index-progress/);
  assert.match(shell, /indexProgress/);
});

test('cloud advice is structured, local-only data remains abstract, and low-risk execution stays opt-in', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /struct CloudAdvice/);
  assert.match(backend, /fn parse_cloud_advice/);
  assert.match(backend, /asset:\/\/restricted/);
  assert.match(backend, /auto_apply_low_risk/);
  assert.match(backend, /fn save_agent_preferences/);
  assert.match(shell, /auto-apply-low-risk/);
  assert.match(shell, /cloudAdvice/);
});

test('model provisioning supports verified resumes and local privacy reports are explicit about disk encryption limits', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /Range/);
  assert.match(backend, /partial/);
  assert.match(backend, /fn get_privacy_status/);
  assert.match(backend, /磁盘加密/);
  assert.match(shell, /privacy-status/);
  assert.match(shell, /磁盘加密/);
});

test('document search pages directly in SQLite and does not materialize every matching item', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const command = backend.slice(backend.indexOf('fn search_documents('), backend.indexOf('#[tauri::command]\nfn preview_file'));
  assert.match(command, /LIMIT \? OFFSET \?/);
  assert.match(command, /SELECT COUNT\(\*\)/);
  assert.doesNotMatch(command, /ask_assistant\(/);
  assert.match(command, /params_from_iter/);
});

test('folder indexing rejects overlapping references and agent auto-apply remains opt-in and constrained', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /拒绝接入重叠文件夹/);
  assert.match(backend, /fn auto_apply_low_risk_agent_advice/);
  assert.match(backend, /auto_apply_low_risk/);
  assert.match(backend, /is_low_risk_advice/);
  assert.match(shell, /auto_apply_low_risk_agent_advice/);
});

test('cloud collaboration prepares a dedicated AI workspace when the user has not selected one', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /async function ensureAiWorkspace/);
  assert.match(shell, /prepare_ai_output/);
  assert.match(shell, /await ensureAiWorkspace/);
});

test('all AI write paths reject existing targets and verified model downloads recover safely from complete partials', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const directWrite = backend.slice(backend.indexOf('fn write_ai_file('), backend.indexOf('fn workspace_root('));
  const download = backend.slice(backend.indexOf('async fn download_to('), backend.indexOf('async fn download_with_fallback('));
  assert.match(directWrite, /target\.exists\(\)/);
  assert.match(directWrite, /拒绝覆盖已有工作区文件/);
  assert.match(directWrite, /create_new\(true\)/);
  assert.match(download, /RANGE_NOT_SATISFIABLE/);
  assert.match(download, /verify_sha256\(&temporary/);
});

test('index progress has an explicit completion phase for UI state recovery', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /phase: "complete"/);
  assert.match(shell, /event\.payload\.phase === 'complete'/);
});

test('desktop automatically notices referenced-folder changes and schedules a safe refresh', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn start_folder_change_watch/);
  assert.match(backend, /RecommendedWatcher/);
  assert.match(backend, /folder-change-detected/);
  assert.match(shell, /folder-change-detected/);
  assert.match(shell, /scheduleFolderRefresh/);
  assert.match(shell, /enqueue_index_job/);
  assert.match(shell, /正在监听已接入资料夹/);
});

test('index refreshes use a persisted single-worker queue with pause, resume, and per-file change tracking', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS index_jobs/);
  assert.match(backend, /source_modified_ms/);
  assert.match(backend, /fn enqueue_index_job/);
  assert.match(backend, /fn pause_index_job/);
  assert.match(backend, /fn resume_index_job/);
  assert.match(backend, /fn incremental_index_folder/);
  assert.match(backend, /index-job-progress/);
  assert.match(shell, /pause_index_job/);
  assert.match(shell, /resume_index_job/);
  assert.match(shell, /indexJobs/);
});

test('local governance creates Windows-key-protected encrypted backups, deferred restores, sensitive reports, and filterable audits', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /Aes256Gcm/);
  assert.match(backend, /fn create_encrypted_backup/);
  assert.match(backend, /fn stage_encrypted_restore/);
  assert.match(backend, /fn apply_pending_restore/);
  assert.match(backend, /fn scan_sensitive_index/);
  assert.match(backend, /fn list_metadata_audit/);
  assert.match(backend, /BACKUP_KEYRING_SERVICE/);
  assert.match(shell, /create_encrypted_backup/);
  assert.match(shell, /stage_encrypted_restore/);
  assert.match(shell, /scan_sensitive_index/);
  assert.match(shell, /list_metadata_audit/);
});

test('document parsing supports PDF body text and read-only Office text previews with explicit local tool availability', async () => {
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(cargo, /lopdf/);
  assert.match(backend, /fn extract_pdf_text/);
  assert.match(backend, /fn get_local_tool_status/);
  assert.match(backend, /fn office_preview_text/);
  assert.match(backend, /ffmpeg/);
});

test('model execution settings and environment acceptance distinguish verified capabilities from user-device checks', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS runtime_settings/);
  assert.match(backend, /fn get_runtime_settings/);
  assert.match(backend, /fn save_runtime_settings/);
  assert.match(backend, /fn run_environment_acceptance/);
  assert.match(backend, /--threads/);
  assert.match(backend, /--ctx-size/);
  assert.match(shell, /run_environment_acceptance/);
  assert.match(shell, /runtime-settings/);
});

test('agent run reports bind restricted sources locally and retain final build evidence without storing source content', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS agent_source_bindings/);
  assert.match(backend, /fn bind_agent_sources/);
  assert.match(backend, /fn get_agent_evidence_report/);
  assert.match(backend, /final_evidence/);
  assert.match(backend, /source_path TEXT/);
  assert.match(shell, /get_agent_evidence_report/);
  assert.match(shell, /agent-evidence-report/);
});

test('semantic retrieval persists real local embedding vectors and only falls back to FTS when no embedding runtime is configured', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS embedding_models/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS item_embeddings/);
  assert.match(backend, /fn register_embedding_model/);
  assert.match(backend, /async fn embed_text/);
  assert.match(backend, /fn cosine_similarity/);
  assert.match(backend, /semantic_search/);
  assert.match(backend, /embedding_fallback_fts/);
  assert.match(shell, /semantic-search/);
  assert.match(shell, /register_embedding_model/);
});

test('application database uses SQLCipher with a Windows-credential key and migrates an existing plaintext database safely', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.match(cargo, /bundled-sqlcipher/);
  assert.match(backend, /DATABASE_KEYRING_SERVICE/);
  assert.match(backend, /PRAGMA key/);
  assert.match(backend, /PRAGMA cipher_version/);
  assert.match(backend, /sqlcipher_export/);
  assert.match(backend, /fn open_app_database/);
});

test('database key recovery never replaces an existing database after an update', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.match(cargo, /windows-sys/);
  assert.match(backend, /DATABASE_KEY_BACKUP_FILE/);
  assert.match(backend, /CryptProtectData/);
  assert.match(backend, /CryptUnprotectData/);
  assert.match(backend, /fn load_database_key\(data_dir: &Path, database_exists: bool\)/);
  assert.match(backend, /已有本地数据库但找不到可用密钥；为保护原数据，应用未创建空数据库。/);
  assert.doesNotMatch(backend, /quarantine_unreadable_database\(data_dir, &database\)/);
});

test('runtime provisioning uses a versioned manifest with archive hashes and explicit GPU compatibility fallback', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /struct RuntimeManifest/);
  assert.match(backend, /RUNTIME_MANIFEST/);
  assert.match(backend, /archive_sha256/);
  assert.match(backend, /fn detect_gpu_compatibility/);
  assert.match(backend, /runtime_variant_for_settings/);
  assert.match(backend, /verify_sha256\(&archive/);
});

test('runtime provisioning extracts llama runtime DLL dependencies beside the executables', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const downloadRuntime = backend.slice(backend.indexOf('async fn download_runtime'), backend.indexOf('fn import_folder'));
  assert.match(downloadRuntime, /runtime_is_ready\(&runtime_dir\)/);
  assert.match(downloadRuntime, /ends_with\("\.exe"\) \|\| file_name\.ends_with\("\.dll"\)/);
  assert.match(backend, /runtime_dir\.join\("llama-cli-impl\.dll"\)/);
  assert.match(backend, /runtime_dir\.join\("llama\.dll"\)/);
});

test('local agent has a deterministic image-gallery fallback when llama runtime is unavailable', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /fn deterministic_image_gallery_advice/);
  assert.match(backend, /fn deterministic_image_gallery_from_request/);
  assert.match(backend, /可点击切换图片|切换图片/);
  assert.match(backend, /deterministic_image_gallery_from_request/);
  assert.match(backend, /fn local_file_uri/);
  assert.match(backend, /file:\/\/\//);
  assert.match(backend, /is_ascii_alphanumeric/);
});

test('AI output workspace can be opened in the inline browser', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn list_ai_workspace_children/);
  assert.match(backend, /list_ai_workspace_children,/);
  assert.match(shell, /id="open-ai-output-folder"/);
  assert.match(shell, /list_ai_workspace_children/);
  assert.match(backend, /path: Option<String>/);
  assert.match(shell, /path: button\.dataset\.path/);
});

test('incremental indexing stores bounded content hashes and keeps metadata through rename, delete, and unavailable roots', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /source_sha256/);
  assert.match(backend, /fn source_content_hash/);
  assert.match(backend, /source_content_hash\(path\)/);
  assert.match(backend, /indexing_handles_renames_deletes_and_unavailable_roots/);
});

test('media gallery persists source-signature thumbnail cache entries outside referenced folders', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS thumbnail_cache/);
  assert.match(backend, /fn get_thumbnail/);
  assert.match(backend, /fn clear_thumbnail_cache/);
  assert.match(backend, /thumbnail_cache_dir/);
  assert.match(backend, /source_signature/);
  assert.match(backend, /pdftoppm/);
  assert.match(shell, /media-gallery/);
  assert.match(shell, /get_thumbnail/);
  assert.match(shell, /clear_thumbnail_cache/);
});

test('OCR and whisper transcription use a bounded persistent local media queue and write only indexed text', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /CREATE TABLE IF NOT EXISTS media_tasks/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS media_extractions/);
  assert.match(backend, /fn enqueue_media_task/);
  assert.match(backend, /fn cancel_media_task/);
  assert.match(backend, /fn start_media_worker/);
  assert.match(backend, /tesseract/);
  assert.match(backend, /whisper-cli/);
  assert.match(backend, /ffmpeg/);
  assert.match(backend, /MAX_MEDIA_OUTPUT_CHARS/);
  assert.match(shell, /enqueue_media_task/);
  assert.match(shell, /media-tasks/);
  assert.match(shell, /cancel_media_task/);
});

test('Office high-fidelity preview converts a referenced file with isolated local LibreOffice output', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn convert_office_preview/);
  assert.match(backend, /soffice/);
  assert.match(backend, /office-preview-cache/);
  assert.match(backend, /--headless/);
  assert.match(backend, /--outdir/);
  assert.match(backend, /OFFICE_PREVIEW_TIMEOUT/);
  assert.match(shell, /convert_office_preview/);
  assert.match(shell, /高保真预览/);
});

test('agent repair uses a maximum two-attempt diagnostic to cloud advice loop with controlled writes and fixed rechecks', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /MAX_AGENT_REPAIR_ATTEMPTS/);
  assert.match(backend, /async fn auto_repair_agent_run/);
  assert.match(backend, /repair_attempts/);
  assert.match(backend, /最小修复/);
  assert.match(backend, /run_workspace_check/);
  assert.match(backend, /apply_agent_advice_inner/);
  assert.match(shell, /auto_repair_agent_run/);
  assert.match(shell, /自动最小修复/);
});

test('desktop accepts a dropped folder and keeps native selection as a fallback', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /getCurrentWindow/);
  assert.match(shell, /onDragDropEvent/);
  assert.match(shell, /event\.payload\.paths/);
  assert.match(shell, /importFolderPath/);
  assert.match(shell, /拖入文件夹/);
});

test('changed folder indexes automatically schedule an incremental embedding update', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(shell, /scheduleEmbeddingUpdate/);
  assert.match(shell, /index-job-progress/);
  assert.match(shell, /build_embedding_index/);
  assert.match(backend, /source_signature/);
  assert.match(backend, /current\.as_deref\(\) != Some\(signature\.as_str\(\)\)/);
});

test('local tool manager installs only fixed winget packages and reports each tool state', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /enum ManagedTool/);
  assert.match(backend, /fn install_local_tool/);
  assert.match(backend, /UB-Mannheim\.TesseractOCR/);
  assert.match(backend, /Gyan\.FFmpeg/);
  assert.match(backend, /TheDocumentFoundation\.LibreOffice/);
  assert.match(backend, /accept-package-agreements/);
  assert.match(shell, /本机工具管理/);
  assert.match(shell, /install_local_tool/);
});

test('agent can modify an existing workspace file only after an explicit recoverable approval', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /allow_existing_edits/);
  assert.match(backend, /agent-edit-backups/);
  assert.match(backend, /拒绝修改已有工作区文件/);
  assert.match(backend, /已创建可恢复备份/);
  assert.match(shell, /批准后修改已有文件/);
  assert.match(shell, /allowExistingEdits: true/);
});

test('assistant workbench combines the task timeline and AI conversation while cloud configuration lives in settings', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /AI 协作台/);
  assert.match(shell, /assistant-shell/);
  assert.match(shell, /cloudProviderSettings\(\)/);
  assert.match(shell, /云端 AI 配置/);
  assert.doesNotMatch(shell, /data-testid="nav-conversations"/);
  assert.doesNotMatch(shell, /data-testid="nav-tasks"/);
  assert.match(shell, /form-warning/);
  assert.match(styles, /\.form-warning/);
  assert.match(styles, /\.control-cluster/);
});

test('metadata editing keeps values in an in-app editor and commits optimistically without a full status refresh', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /let metadataEditor:/);
  assert.match(shell, /metadata-editor/);
  assert.match(shell, /saveMetadataEditor/);
  assert.match(shell, /updateMetadataOptimistically/);
  const editHandler = shell.slice(shell.indexOf('async function editMetadata'), shell.indexOf('async function chooseAiOutputFolder'));
  assert.doesNotMatch(editHandler, /refreshStatus\(\)/);
  assert.doesNotMatch(editHandler, /window\.prompt/);
});

test('complex local tasks generate reviewed workspace files before escalating to cloud collaboration', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /async fn run_local_agent_task/);
  assert.match(backend, /running_local/);
  assert.match(backend, /awaiting_approval/);
  assert.match(backend, /needs_cloud_assistance/);
  assert.match(backend, /仅返回 JSON/);
  assert.match(shell, /run_local_agent_task/);
  assert.match(shell, /runLocalAgentTask/);
  assert.match(shell, /awaiting_local_execution/);
});

test('cloud escalation starts automatically only for a configured automatic route and otherwise guides users to configuration', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /agentRun\.route === 'cloud_auto' && \['prepared', 'needs_cloud_assistance'\]\.includes\(agentRun\.status\)/);
  assert.match(shell, /const cloudEscalation/);
  assert.match(shell, /data-view="settings">前往云端 AI 配置/);
});

test('search result metadata uses explicit grid rows so indexing and cloud labels cannot overlap', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.result > \.index-state\{grid-column:2;grid-row:3/);
  assert.match(styles, /\.result > \.metadata-line\{grid-column:2\/4;grid-row:4/);
});

test('desktop refuses to replace an unreadable local database with an empty database', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /database-recovery/);
  assert.match(backend, /startup_recovery_notice/);
  assert.match(backend, /应用未创建空数据库/);
  assert.match(shell, /recoveryNotice/);
  assert.match(shell, /数据库恢复提示/);
});

test('desktop automatically retries preserved encrypted databases and merges readable records without replacing newer data', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn restore_quarantined_databases/);
  assert.match(backend, /ATTACH DATABASE/);
  assert.match(backend, /INSERT OR IGNORE INTO main/);
  assert.match(backend, /AUTO_RESTORE_STATUS\.txt/);
  assert.match(backend, /已自动尝试恢复/);
  assert.match(shell, /recoveryNotice/);
});

test('upgrades preserve and automatically restore the executable sibling library', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const config = await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
  const hooks = await readFile(new URL('../src-tauri/nsis-hooks.nsh', import.meta.url), 'utf8');
  assert.match(backend, /fn restore_install_backup/);
  assert.match(backend, /资料终端数据\.install-backup/);
  assert.match(backend, /restore_install_backup\(&executable_dir\)/);
  assert.match(config, /"installerHooks":\s*"nsis-hooks\.nsh"/);
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /NSIS_HOOK_POSTINSTALL/);
  assert.match(hooks, /资料终端数据\.install-backup/);
  assert.doesNotMatch(hooks, /\ndone:/);
  assert.match(hooks, /preserve_done:/);
  assert.match(hooks, /restore_done:/);
  assert.match(shell, /#media-settings button\{[^}]*white-space:nowrap/);
});

test('desktop updates cloud permission optimistically, imports files into managed storage, and exposes accessible settings', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /applyMetadataPolicyOptimistically/);
  assert.match(shell, /update_metadata/);
  assert.match(shell, /applyMetadataPolicyOptimistically\(target, policy\);\s*\n\s*return;/);
  assert.match(shell, /importFilesToLibrary/);
  assert.match(shell, /data-import-files/);
  assert.match(shell, /data-view="settings"/);
  assert.match(shell, /fontScale/);
  assert.match(shell, /checkForUpdate\(true\)/);
  assert.match(backend, /fn import_files_to_library/);
  assert.match(backend, /uploaded-files/);
  assert.match(backend, /fs::copy/);
  assert.match(styles, /\.file-upload-card/);
  assert.match(styles, /\.settings-page/);
  assert.match(styles, /#app\{zoom:var\(--user-font-scale\)\}/);
});

test('about page owns signed in-app update actions and restarts after installation', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /type View = .*'about'/);
  assert.match(shell, /function aboutPage\(\)/);
  assert.match(shell, /data-view="about"/);
  assert.match(shell, /id="check-update"/);
  assert.match(shell, /id="install-update"/);
  assert.match(shell, /update\.downloadAndInstall/);
  assert.match(shell, /await relaunch\(\)/);
});

test('update checks expose a separate loading state, retry path, and bounded network retries', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /type UpdateCheckState = 'idle' \| 'checking' \| 'success' \| 'error'/);
  assert.match(shell, /updateCheckState = 'checking'/);
  assert.match(shell, /timeout:\s*30000/);
  assert.match(shell, /attempts < 3/);
  assert.match(shell, /id="check-update-retry"/);
  assert.match(shell, /update-check-progress/);
  assert.match(shell, /GitHub 更新服务/);
  assert.match(styles, /\.update-check-progress/);
  assert.match(styles, /\.workspace-extras-grid/);
});

test('update installation reuses the checked signed update instead of decoding latest.json twice', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const config = await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
  assert.match(shell, /let pendingUpdate: Update \| null = null/);
  assert.match(shell, /pendingUpdate = update/);
  const installHandler = shell.slice(shell.indexOf('async function installUpdate'), shell.indexOf('function bind'));
  assert.match(installHandler, /const update = pendingUpdate \?\? await check/);
  assert.match(config, /latest\.json\?cache=\{\{current_version\}\}/);
});

test('updater requests an uncompressed response for proxy-safe GitHub downloads', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /Accept-Encoding': 'identity'/);
  assert.match(shell, /check\(updaterRequestOptions\)/);
  assert.match(shell, /\}, updaterRequestOptions\);/);
  assert.match(shell, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
});

test('start-task control exposes an immediate in-progress label while local planning starts', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /isWorking \? '正在启动任务…' : '开始任务'/);
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.task-starting/);
  assert.match(styles, /\.assistant-shell \.chat-message\.user/);
});

test('desktop layout keeps wide pages readable and responsive', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /workspace-extras-grid/);
  assert.match(styles, /--page-max-width/);
  assert.match(styles, /\.canvas\{[^}]*max-width:none/);
  assert.match(styles, /\.search-page,\.assistant-page\{[^}]*max-width:none/);
  assert.match(styles, /\.about-page\{[^}]*max-width:none/);
  assert.match(styles, /@media\(max-width:760px\)/);
});

test('workspace folders and local conversation history use readable desktop information density', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /conversation-empty/);
  assert.match(shell, /本机对话记录<\/b><small>/);
  assert.match(styles, /\.folder-reference-row \.remove-folder-reference\{width:106px/);
  assert.match(styles, /\.conversation-layout\.standalone\{grid-template-columns:280px minmax\(0,1fr\)/);
  assert.match(styles, /\.chat-empty\{display:grid;place-items:center/);
});

test('managed model and language downloads use a resumable persistent task queue', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /FIXED_DOWNLOAD_RESOURCES/);
  assert.match(backend, /ggml-tiny\.bin/);
  assert.match(backend, /chi_sim\.traineddata/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS download_tasks/);
  assert.match(backend, /fn start_download_worker/);
  assert.match(backend, /fn retry_download_task/);
  assert.match(backend, /fn cancel_download_task/);
  assert.match(backend, /recover_incomplete_download_tasks/);
  assert.match(shell, /retry-download-task/);
  assert.match(shell, /cancel-download-task/);
});

test('watcher failures fall back to bounded scans and real WebView automation has stable selectors', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const e2e = await readFile(new URL('../tests/tauri-e2e/desktop-webview.test.mjs', import.meta.url), 'utf8');
  assert.match(backend, /struct FolderWatchHealth/);
  assert.match(backend, /FALLBACK_SCAN_INTERVAL_MS/);
  assert.match(backend, /watched_roots\.clear\(\)/);
  assert.match(backend, /FILE_TERMINAL_TEST_DATA_DIR/);
  assert.match(shell, /data-testid="nav-search"/);
  assert.match(shell, /data-testid="nav-diagnostics"/);
  assert.match(shell, /assistant-shell/);
  assert.match(e2e, /tauri:options/);
  assert.match(e2e, /TAURI_E2E_APP/);
});

test('Codex-style workbench keeps files in a right inspector and offers local and cloud model choices', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(shell, /function rightInspector\(\)/);
  assert.match(shell, /id="assistant-model-choice"/);
  assert.match(shell, /<optgroup label="本地模型">/);
  assert.match(shell, /<optgroup label="云端模型">/);
  assert.match(shell, /executionPreference/);
  assert.match(backend, /execution_preference/);
  assert.match(styles, /\.right-inspector\{position:fixed/);
  assert.match(styles, /\.assistant-shell\{display:grid/);
  assert.match(styles, /\.inspector-open main\{margin-right:420px/);
});

test('AI workbench conversation history uses the expanded dark sidebar language', async () => {
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(shell, /assistant-history-section/);
  assert.match(shell, /assistant-history-brand/);
  assert.match(shell, /assistant-history-new/);
  assert.match(shell, /assistant-history-foot/);
  assert.match(shell, /data-new-conversation/);
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.assistant-history\{[^}]*background:#17212f/);
  assert.match(styles, /\.assistant-history \.conversation-item\.active/);
});
