// 备份 / 恢复：配置（JSON）与全部数据（zip，含音频）的导出与导入。
//
// 设计要点：
// - 导入走活动数据库的正常写入通道（app_settings upsert + 集合表整表替换），
//   不替换 sqlite 文件、不涉及文件锁，导入完成后由前端触发重启使内存状态重载。
// - 语义为「覆盖」：集合表整表替换；app_settings 逐 key 覆盖（不删除未出现的 key）。
// - 「配置」不含使用统计 stats，避免覆盖本机计数；「全部」包含 stats。
// - 全部导入时，历史记录里的 audioFilePath 是旧机绝对路径，会重写为本机 audio 目录下的同名文件。

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::storage::Storage;

/// 备份文件格式版本。导入时若备份版本高于此值则拒绝。
const FORMAT_VERSION: i64 = 1;
/// 「配置」档不导出/导入的 app_settings key（使用统计属于使用数据，不属于配置）。
const CONFIG_EXCLUDE: &[&str] = &["stats"];

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn audio_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("audio")
}

fn backup_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.sayit.app")
        })
        .join("SayIt Backups")
}

fn timestamped_backup_path(prefix: &str, extension: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S-%3f");
    backup_dir().join(format!("{}-{}.{}", prefix, timestamp, extension))
}

/// 取路径的文件名部分（兼容 / 和 \ 分隔符，跨平台备份用）。
fn basename(path: &str) -> String {
    path.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn build_config_value(storage: &Storage) -> Value {
    json!({
        "kind": "config",
        "formatVersion": FORMAT_VERSION,
        "appVersion": app_version(),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "appSettings": storage.export_app_settings(CONFIG_EXCLUDE),
        "promptPresets": storage.get("promptPresets", None),
        "appPromptRules": storage.get("appPromptRules", None),
    })
}

fn build_full_value(storage: &Storage) -> Value {
    json!({
        "kind": "full",
        "formatVersion": FORMAT_VERSION,
        "appVersion": app_version(),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "appSettings": storage.export_app_settings(&[]),
        "promptPresets": storage.get("promptPresets", None),
        "appPromptRules": storage.get("appPromptRules", None),
        "history": storage.get("history", None),
        "manualCorrections": storage.get("manualCorrections", None),
        "feedbackQueue": storage.get("feedbackQueue", None),
    })
}

fn check_version(data: &Value) -> Result<(), String> {
    let v = data.get("formatVersion").and_then(|x| x.as_i64()).unwrap_or(0);
    if v > FORMAT_VERSION {
        return Err(format!(
            "备份文件版本（{}）高于当前应用支持的版本（{}），请升级 SayIt 后再导入。",
            v, FORMAT_VERSION
        ));
    }
    Ok(())
}

/// 应用配置部分（设置 + prompt 预设 + 分应用规则），两档共用。
fn apply_config_part(storage: &Storage, data: &Value, settings_exclude: &[&str]) -> Result<(), String> {
    if let Some(obj) = data.get("appSettings").and_then(|v| v.as_object()) {
        storage
            .import_app_settings(obj, settings_exclude)
            .map_err(|e| format!("写入设置失败: {}", e))?;
    }
    if let Some(arr) = data.get("promptPresets") {
        if arr.is_array() {
            storage.set("promptPresets", arr).map_err(|e| format!("写入 Prompt 预设失败: {}", e))?;
        }
    }
    if let Some(arr) = data.get("appPromptRules") {
        if arr.is_array() {
            storage.set("appPromptRules", arr).map_err(|e| format!("写入应用规则失败: {}", e))?;
        }
    }
    Ok(())
}

/// 重写单条历史记录的音频路径：把目录段换成本机 audio 目录，文件名不变。
fn rewrite_audio_path(rec: &Value, adir: &Path) -> Value {
    let mut rec = rec.clone();
    if let Some(obj) = rec.as_object_mut() {
        if let Some(p) = obj.get("audioFilePath").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            let base = basename(&p);
            if !base.is_empty() {
                let new_path = adir.join(&base).to_string_lossy().to_string();
                obj.insert("audioFilePath".to_string(), Value::String(new_path));
            }
        }
    }
    rec
}

// ─── 导出 ───

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportProgress {
    status: String,
    phase: String,
    file_path: String,
    current_file: Option<String>,
    processed_files: u64,
    total_files: u64,
    processed_bytes: u64,
    total_bytes: u64,
    percent: f64,
    error: Option<String>,
}

struct AudioExportFile {
    path: PathBuf,
    name: String,
    size: u64,
}

fn emit_export_progress(app: &AppHandle, progress: BackupExportProgress) {
    let _ = app.emit("backup-export-progress", progress);
}

fn collect_audio_export_files() -> Vec<AudioExportFile> {
    let mut files = Vec::new();
    let adir = audio_dir();
    if let Ok(entries) = fs::read_dir(adir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.is_empty() {
                files.push(AudioExportFile {
                    path,
                    name,
                    size: metadata.len(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

fn audio_progress_percent(processed_bytes: u64, total_bytes: u64) -> f64 {
    if total_bytes == 0 {
        95.0
    } else {
        (5.0 + processed_bytes as f64 / total_bytes as f64 * 90.0).min(95.0)
    }
}

#[tauri::command]
pub fn get_backup_directory() -> Result<String, String> {
    let directory = backup_dir();
    fs::create_dir_all(&directory).map_err(|e| format!("创建备份目录失败: {}", e))?;
    Ok(directory.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn export_config(storage: State<'_, Storage>) -> Result<String, String> {
    let out_path = timestamped_backup_path("sayit-config", "json");
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败: {}", e))?;
    }
    let payload = build_config_value(storage.inner());
    let content = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&out_path, content).map_err(|e| format!("写入文件失败: {}", e))?;
    let path = out_path.to_string_lossy().to_string();
    log::info!("Config backup exported to {}", path);
    Ok(path)
}

#[tauri::command]
pub async fn export_full(
    app: AppHandle,
    storage: State<'_, Storage>,
) -> Result<String, String> {
    let output = timestamped_backup_path("sayit-backup", "zip");
    let out_path = output.to_string_lossy().to_string();
    let temp_path = PathBuf::from(format!("{}.part", out_path));
    let audio_files = collect_audio_export_files();
    let total_files = audio_files.len() as u64;
    let total_bytes = audio_files.iter().map(|file| file.size).sum::<u64>();

    emit_export_progress(
        &app,
        BackupExportProgress {
            status: "running".to_string(),
            phase: "preparing".to_string(),
            file_path: out_path.clone(),
            current_file: None,
            processed_files: 0,
            total_files,
            processed_bytes: 0,
            total_bytes,
            percent: 2.0,
            error: None,
        },
    );

    let export_result = (|| -> Result<(), String> {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {}", e))?;
        }

        let payload = build_full_value(storage.inner());
        let json_str = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        emit_export_progress(
            &app,
            BackupExportProgress {
                status: "running".to_string(),
                phase: "packingData".to_string(),
                file_path: out_path.clone(),
                current_file: Some("backup.json".to_string()),
                processed_files: 0,
                total_files,
                processed_bytes: 0,
                total_bytes,
                percent: 5.0,
                error: None,
            },
        );

        let file = fs::File::create(&temp_path).map_err(|e| format!("创建文件失败: {}", e))?;
        let mut zip = zip::ZipWriter::new(file);
        let text_opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let audio_opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        zip.start_file("backup.json", text_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(json_str.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut processed_bytes = 0u64;
        let mut processed_files = 0u64;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut buffer = vec![0u8; 256 * 1024];

        for audio in &audio_files {
            zip.start_file(format!("audio/{}", audio.name), audio_opts)
                .map_err(|e| e.to_string())?;
            let mut source = fs::File::open(&audio.path)
                .map_err(|e| format!("读取音频 {} 失败: {}", audio.name, e))?;

            loop {
                let read = source
                    .read(&mut buffer)
                    .map_err(|e| format!("读取音频 {} 失败: {}", audio.name, e))?;
                if read == 0 {
                    break;
                }
                zip.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
                processed_bytes += read as u64;

                if last_emit.elapsed() >= Duration::from_millis(150) {
                    emit_export_progress(
                        &app,
                        BackupExportProgress {
                            status: "running".to_string(),
                            phase: "packingAudio".to_string(),
                            file_path: out_path.clone(),
                            current_file: Some(audio.name.clone()),
                            processed_files,
                            total_files,
                            processed_bytes,
                            total_bytes,
                            percent: audio_progress_percent(processed_bytes, total_bytes),
                            error: None,
                        },
                    );
                    last_emit = Instant::now();
                }
            }

            processed_files += 1;
            emit_export_progress(
                &app,
                BackupExportProgress {
                    status: "running".to_string(),
                    phase: "packingAudio".to_string(),
                    file_path: out_path.clone(),
                    current_file: Some(audio.name.clone()),
                    processed_files,
                    total_files,
                    processed_bytes,
                    total_bytes,
                    percent: audio_progress_percent(processed_bytes, total_bytes),
                    error: None,
                },
            );
        }

        emit_export_progress(
            &app,
            BackupExportProgress {
                status: "running".to_string(),
                phase: "finalizing".to_string(),
                file_path: out_path.clone(),
                current_file: None,
                processed_files,
                total_files,
                processed_bytes,
                total_bytes,
                percent: 98.0,
                error: None,
            },
        );
        zip.finish().map_err(|e| e.to_string())?;

        if output.exists() {
            fs::remove_file(&output).map_err(|e| format!("替换旧备份失败: {}", e))?;
        }
        fs::rename(&temp_path, &output).map_err(|e| format!("完成备份文件失败: {}", e))?;
        Ok(())
    })();

    match export_result {
        Ok(()) => {
            emit_export_progress(
                &app,
                BackupExportProgress {
                    status: "completed".to_string(),
                    phase: "completed".to_string(),
                    file_path: out_path.clone(),
                    current_file: None,
                    processed_files: total_files,
                    total_files,
                    processed_bytes: total_bytes,
                    total_bytes,
                    percent: 100.0,
                    error: None,
                },
            );
            log::info!("Full backup exported to {}", out_path);
            Ok(out_path)
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            emit_export_progress(
                &app,
                BackupExportProgress {
                    status: "failed".to_string(),
                    phase: "failed".to_string(),
                    file_path: out_path,
                    current_file: None,
                    processed_files: 0,
                    total_files,
                    processed_bytes: 0,
                    total_bytes,
                    percent: 0.0,
                    error: Some(error.clone()),
                },
            );
            Err(error)
        }
    }
}

// ─── 导入 ───

#[tauri::command]
pub async fn import_config(in_path: String, storage: State<'_, Storage>) -> Result<(), String> {
    let content = fs::read_to_string(&in_path).map_err(|e| format!("读取文件失败: {}", e))?;
    let data: Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析失败（文件可能损坏或格式不正确）: {}", e))?;
    check_version(&data)?;
    // 配置导入排除 stats，避免覆盖本机使用统计
    apply_config_part(storage.inner(), &data, CONFIG_EXCLUDE)?;
    Ok(())
}

#[tauri::command]
pub async fn import_full(in_path: String, storage: State<'_, Storage>) -> Result<(), String> {
    let file = fs::File::open(&in_path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的备份压缩包: {}", e))?;

    // 1. 读取并校验 backup.json
    let mut json_str = String::new();
    {
        let mut entry = archive
            .by_name("backup.json")
            .map_err(|_| "备份包缺少 backup.json，可能不是 SayIt 全量备份。".to_string())?;
        entry.read_to_string(&mut json_str).map_err(|e| e.to_string())?;
    }
    let data: Value = serde_json::from_str(&json_str).map_err(|e| format!("解析 backup.json 失败: {}", e))?;
    check_version(&data)?;

    // 2. 释放音频文件到本机 audio 目录
    let adir = audio_dir();
    fs::create_dir_all(&adir).map_err(|e| format!("创建音频目录失败: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if let Some(rest) = name.strip_prefix("audio/") {
            if rest.is_empty() || entry.is_dir() {
                continue;
            }
            let base = basename(rest);
            if base.is_empty() {
                continue;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            fs::write(adir.join(&base), &buf).map_err(|e| format!("写入音频 {} 失败: {}", base, e))?;
        }
    }

    // 3. 应用配置部分（含 stats）
    apply_config_part(storage.inner(), &data, &[])?;

    // 4. 历史：重写音频路径后整表替换
    if let Some(history) = data.get("history").and_then(|v| v.as_array()) {
        let rewritten: Vec<Value> = history.iter().map(|rec| rewrite_audio_path(rec, &adir)).collect();
        storage
            .set("history", &Value::Array(rewritten))
            .map_err(|e| format!("写入历史失败: {}", e))?;
    }
    if let Some(arr) = data.get("manualCorrections") {
        if arr.is_array() {
            storage.set("manualCorrections", arr).map_err(|e| format!("写入人工校正失败: {}", e))?;
        }
    }
    if let Some(arr) = data.get("feedbackQueue") {
        if arr.is_array() {
            storage.set("feedbackQueue", arr).map_err(|e| format!("写入反馈队列失败: {}", e))?;
        }
    }
    Ok(())
}

/// 导入完成后由前端调用，重启应用使内存中的设置/供应商状态全量重载。
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}
