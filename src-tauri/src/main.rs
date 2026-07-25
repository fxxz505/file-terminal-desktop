#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use file_terminal_desktop::assistant::{extract_search_terms, matches_terms, parse_model_terms};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use walkdir::WalkDir;

const APP_FOLDER: &str = "资料终端";
const RUNTIME_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip";
const MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MODEL_FILE: &str = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MAX_PREVIEW_BYTES: u64 = 1_048_576;

struct AppState {
    database: Mutex<Connection>,
    data_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexItem {
    id: String,
    item_type: String,
    name: String,
    path: String,
    note: String,
    tags: Vec<String>,
    score: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderRef {
    id: String,
    name: String,
    path: String,
    note: String,
    tags: Vec<String>,
    item_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderImport {
    path: String,
    note: String,
    tags: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    kind: String,
    completed: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    model_installed: bool,
    runtime_installed: bool,
    model_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
    kind: String,
    name: String,
    path: String,
    mime_type: String,
    content: String,
    message: String,
    truncated: bool,
}

fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join(APP_FOLDER))
        .ok_or_else(|| "无法定位 Windows 本地应用数据目录。".to_string())
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS folder_refs (
                id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                note TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS index_items (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                item_type TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                note TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                FOREIGN KEY(folder_id) REFERENCES folder_refs(id)
            );
            CREATE INDEX IF NOT EXISTS index_items_folder_idx ON index_items(folder_id);
            ",
        )
        .map_err(|error| error.to_string())
}

fn validate_folder_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err("请选择一个存在的文件夹。".to_string());
    }
    fs::canonicalize(path).map_err(|error| format!("无法访问文件夹：{error}"))
}

fn indexed_path(path: &Path, state: &AppState) -> Result<PathBuf, String> {
    let target = fs::canonicalize(path).map_err(|_| "文件不存在或无法访问。".to_string())?;
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT root_path FROM folder_refs")
        .map_err(|error| error.to_string())?;
    let roots = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let permitted = roots
        .filter_map(Result::ok)
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| target.starts_with(root));
    permitted.then_some(target).ok_or_else(|| "只能预览已接入资料夹中的文件。".to_string())
}

fn preview_mime(extension: &str) -> Option<(&'static str, &'static str)> {
    match extension {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "bmp" => Some(("image", "image/bmp")),
        "pdf" => Some(("pdf", "application/pdf")),
        "txt" | "md" | "csv" | "json" | "log" | "rs" | "ts" | "js" | "html" | "css" | "xml" | "yml" | "yaml" | "toml" => Some(("text", "text/plain")),
        _ => None,
    }
}

fn safe_file_name(url: &str, default_name: &str) -> String {
    url.rsplit('/')
        .next()
        .filter(|name| !name.is_empty() && !name.contains('?'))
        .unwrap_or(default_name)
        .to_string()
}

fn model_terms(question: &str, data_dir: &Path) -> Vec<String> {
    let runtime = data_dir.join("runtime").join("llama-cli.exe");
    let model = data_dir.join("models").join(MODEL_FILE);
    if !runtime.is_file() || !model.is_file() {
        return extract_search_terms(question);
    }
    let prompt = format!(
        "You extract local-file search keywords. Return only a comma-separated list of at most 6 Chinese or English keywords. User question: {question}"
    );
    let output = Command::new(runtime)
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt)
        .arg("-n")
        .arg("48")
        .arg("--temp")
        .arg("0")
        .output();
    output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| parse_model_terms(&String::from_utf8_lossy(&result.stdout)))
        .filter(|terms| !terms.is_empty())
        .unwrap_or_else(|| extract_search_terms(question))
}

async fn download_to(
    app: AppHandle,
    kind: &str,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载请求失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载地址不可用：{error}"))?;
    let total = response.content_length();
    let temporary = destination.with_extension("partial");
    let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut completed = 0_u64;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| format!("下载中断：{error}"))?;
        output.write_all(&bytes).map_err(|error| error.to_string())?;
        completed += bytes.len() as u64;
        app.emit(
            "download-progress",
            DownloadProgress {
                kind: kind.to_string(),
                completed,
                total,
            },
        )
        .map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())?;
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    let model_path = state.data_dir.join("models").join(MODEL_FILE);
    let runtime_dir = state.data_dir.join("runtime");
    RuntimeStatus {
        model_installed: model_path.is_file(),
        runtime_installed: runtime_dir.join("llama-server.exe").is_file()
            || runtime_dir.join("llama-cli.exe").is_file(),
        model_path: model_path.display().to_string(),
    }
}

#[tauri::command]
async fn download_model(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let models_dir = state.data_dir.join("models");
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let target = models_dir.join(MODEL_FILE);
    if !target.is_file() {
        download_to(app, "model", MODEL_URL, &target).await?;
    }
    Ok(get_runtime_status(state))
}

#[tauri::command]
async fn download_runtime(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let runtime_dir = state.data_dir.join("runtime");
    fs::create_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    let archive = state.data_dir.join(safe_file_name(RUNTIME_URL, "llama-runtime.zip"));
    download_to(app.clone(), "runtime", RUNTIME_URL, &archive).await?;
    let file = File::open(&archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let Some(file_name) = Path::new(entry.name()).file_name() else { continue };
        if !matches!(file_name.to_string_lossy().as_ref(), "llama-server.exe" | "llama-cli.exe") {
            continue;
        }
        let output = runtime_dir.join(file_name);
        let mut writer = File::create(output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|error| error.to_string())?;
    }
    let _ = fs::remove_file(archive);
    Ok(get_runtime_status(state))
}

#[tauri::command]
fn import_folder(input: FolderImport, state: State<'_, AppState>) -> Result<usize, String> {
    let root = validate_folder_path(&input.path)?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名文件夹")
        .to_string();
    let folder_id = Uuid::new_v4().to_string();
    let tags_json = serde_json::to_string(&input.tags).map_err(|error| error.to_string())?;
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;

    connection
        .execute("DELETE FROM index_items WHERE folder_id IN (SELECT id FROM folder_refs WHERE root_path = ?1)", params![root.display().to_string()])
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM folder_refs WHERE root_path = ?1", params![root.display().to_string()])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO folder_refs (id, root_path, name, note, tags_json, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![folder_id, root.display().to_string(), name, input.note, tags_json],
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO index_items (id, folder_id, item_type, name, path, note, tags_json) VALUES (?1, ?2, 'folder', ?3, ?4, ?5, ?6)",
            params![Uuid::new_v4().to_string(), folder_id, name, root.display().to_string(), input.note, serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string())],
        )
        .map_err(|error| error.to_string())?;

    let mut count = 1;
    for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok) {
        if entry.path() == root { continue; }
        let kind = if entry.file_type().is_dir() { "folder" } else { "file" };
        let item_name = entry.file_name().to_string_lossy().to_string();
        let item_path = entry.path().display().to_string();
        connection
            .execute(
                "INSERT INTO index_items (id, folder_id, item_type, name, path, note, tags_json) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6)",
                params![Uuid::new_v4().to_string(), folder_id, kind, item_name, item_path, serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string())],
            )
            .map_err(|error| error.to_string())?;
        count += 1;
    }
    Ok(count)
}

#[tauri::command]
fn list_folder_refs(state: State<'_, AppState>) -> Result<Vec<FolderRef>, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT folder_refs.id, folder_refs.name, folder_refs.root_path, folder_refs.note, folder_refs.tags_json, COUNT(index_items.id)
             FROM folder_refs LEFT JOIN index_items ON index_items.folder_id = folder_refs.id
             GROUP BY folder_refs.id
             ORDER BY folder_refs.imported_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, usize>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(|(id, name, path, note, tags_json, item_count)| FolderRef {
            id,
            name,
            path,
            note,
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            item_count,
        })
        .collect())
}

#[tauri::command]
fn ask_assistant(question: String, state: State<'_, AppState>) -> Result<Vec<IndexItem>, String> {
    let terms = model_terms(&question, &state.data_dir);
    if terms.is_empty() { return Ok(Vec::new()); }
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT index_items.id, index_items.item_type, index_items.name, index_items.path, folder_refs.note, folder_refs.tags_json
             FROM index_items INNER JOIN folder_refs ON index_items.folder_id = folder_refs.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut results = rows
        .filter_map(Result::ok)
        .filter_map(|(id, item_type, name, path, note, tags_json)| {
            let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
            let score = matches_terms(&format!("{name} {path} {note} {}", tags.join(" ")), &terms);
            (score > 0).then_some(IndexItem { id, item_type, name, path, note, tags, score })
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| right.score.cmp(&left.score).then_with(|| left.name.cmp(&right.name)));
    results.truncate(30);
    Ok(results)
}

#[tauri::command]
fn preview_file(path: String, state: State<'_, AppState>) -> Result<FilePreview, String> {
    let target = indexed_path(Path::new(&path), &state)?;
    let name = target.file_name().and_then(|value| value.to_str()).unwrap_or("未命名文件").to_string();
    if target.is_dir() {
        return Ok(FilePreview { kind: "folder".into(), name, path: target.display().to_string(), mime_type: String::new(), content: String::new(), message: "文件夹不能直接预览；可在资源管理器中打开。".into(), truncated: false });
    }
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    let extension = target.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let Some((kind, mime_type)) = preview_mime(&extension) else {
        return Ok(FilePreview { kind: "unsupported".into(), name, path: target.display().to_string(), mime_type: String::new(), content: String::new(), message: "此文件格式暂不支持内置预览；可在资源管理器中打开。".into(), truncated: false });
    };
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Ok(FilePreview { kind: "unsupported".into(), name, path: target.display().to_string(), mime_type: mime_type.into(), content: String::new(), message: "文件超过 1 MB，为避免卡顿未加载预览；可在资源管理器中打开。".into(), truncated: true });
    }
    let bytes = fs::read(&target).map_err(|error| error.to_string())?;
    let (content, message) = match kind {
        "text" => (String::from_utf8_lossy(&bytes).to_string(), String::new()),
        _ => (BASE64.encode(bytes), String::new()),
    };
    Ok(FilePreview { kind: kind.into(), name, path: target.display().to_string(), mime_type: mime_type.into(), content, message, truncated: false })
}

#[tauri::command]
fn reveal_in_explorer(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let target = indexed_path(Path::new(&path), &state)?;
    let mut command = Command::new("explorer.exe");
    if target.is_file() {
        command.arg("/select,").arg(&target);
    } else {
        command.arg(&target);
    }
    command.spawn().map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

fn main() {
    let data_dir = app_data_dir().expect("unable to locate app data directory");
    fs::create_dir_all(&data_dir).expect("unable to create app data directory");
    let connection = Connection::open(data_dir.join("file-terminal.db")).expect("unable to open database");
    initialize_database(&connection).expect("unable to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { database: Mutex::new(connection), data_dir })
        .invoke_handler(tauri::generate_handler![get_runtime_status, download_model, download_runtime, import_folder, list_folder_refs, ask_assistant, preview_file, reveal_in_explorer])
        .run(tauri::generate_context!())
        .expect("error while running 资料终端");
}

#[cfg(test)]
mod preview_tests {
    use super::preview_mime;

    #[test]
    fn classifies_supported_preview_extensions() {
        assert_eq!(preview_mime("png"), Some(("image", "image/png")));
        assert_eq!(preview_mime("md"), Some(("text", "text/plain")));
        assert_eq!(preview_mime("pdf"), Some(("pdf", "application/pdf")));
        assert_eq!(preview_mime("docx"), None);
    }
}
