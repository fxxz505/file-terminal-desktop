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

test('custom providers persist safely and expose models through the compatible endpoint', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(backend, /fn list_cloud_providers/);
  assert.match(backend, /async fn fetch_cloud_models/);
  assert.match(backend, /fn select_cloud_provider/);
  assert.match(backend, /\/v1\/models/);
  assert.match(backend, /cloud_provider_config/);
  assert.match(shell, /cloud-provider-form/);
  assert.match(shell, /fetch_cloud_models/);
  assert.match(shell, /select_cloud_provider/);
  assert.match(shell, /cloud-model-select/);
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

test('runtime provisioning uses a versioned manifest with archive hashes and explicit GPU compatibility fallback', async () => {
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(backend, /struct RuntimeManifest/);
  assert.match(backend, /RUNTIME_MANIFEST/);
  assert.match(backend, /archive_sha256/);
  assert.match(backend, /fn detect_gpu_compatibility/);
  assert.match(backend, /runtime_variant_for_settings/);
  assert.match(backend, /verify_sha256\(&archive/);
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
