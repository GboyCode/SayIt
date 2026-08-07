// 豆包流式语音识别 2.0 — 使用流式输入模式（bigmodel_nostream）
// 录完后一次性发送 PCM 音频，等最终结果返回

use super::doubao_auth::{self, DoubaoAuth};
use super::doubao_protocol;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio_tungstenite::tungstenite;

const WS_URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";

/// 建立 nostream 连接：按「小时版 → 并发版」依次试资源 ID。
///
/// 之前这里写死小时版，而双向流式路径早就在两者间兜底了 —— 于是只开通并发版的账号
/// 出现「实时字幕能用、普通录音识别连不上」这种自相矛盾的现象。两条路径口径统一。
async fn connect(
    auth: &DoubaoAuth<'_>,
    scope: &str,
) -> Result<(tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, &'static str), String> {
    let mut last_err = String::from("未知错误");
    for resource_id in doubao_auth::SAUC_RESOURCE_CANDIDATES {
        let mut builder = tungstenite::http::Request::builder()
            .uri(WS_URL)
            .header("Host", "openspeech.bytedance.com")
            .header("X-Api-Resource-Id", *resource_id)
            .header("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string())
            .header(
                "Sec-WebSocket-Key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("Sec-WebSocket-Version", "13")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket");
        for (name, value) in auth.headers() {
            builder = builder.header(name, value);
        }
        let request = builder
            .body(())
            .map_err(|e| format!("构建请求失败: {}", e))?;

        match tokio_tungstenite::connect_async(request).await {
            Ok((ws, response)) => {
                doubao_auth::log_ws_logid(
                    &format!("{} resourceId={} auth={}", scope, resource_id, auth.mode_name()),
                    &response,
                );
                return Ok((ws, resource_id));
            }
            Err(e) => {
                last_err = e.to_string();
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao] {} connect FAILED resourceId={} auth={} err={}",
                    scope,
                    resource_id,
                    auth.mode_name(),
                    last_err
                ));
            }
        }
    }
    Err(format!("WebSocket 连接失败: {}", last_err))
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let pcm_data = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_pcm_b64,
    )
    .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm_data.is_empty() {
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let auth = DoubaoAuth::from_config(config);
    if let Some(missing) = auth.missing_field() {
        return Err(format!("豆包 ASR 缺少{}，请在设置里填好", missing));
    }
    let uid = auth.uid().to_string();

    let start = Instant::now();

    let (mut ws, _resource_id) = connect(&auth, "nostream").await?;

    // 1. 发送 full client request
    let mut request_params = serde_json::json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
        "result_type": "full",
        "show_utterances": true
    });
    // 注入热词（如果有）：流式接口热词须放在 request.corpus.context
    if let Some(ctx) = doubao_protocol::build_hotword_context(hotwords) {
        request_params["corpus"] = serde_json::json!({ "context": ctx });
    }

    let client_request = serde_json::json!({
        "user": { "uid": uid },
        "audio": {
            "format": "pcm",
            "rate": sample_rate,
            "bits": 16,
            "channel": 1
        },
        "request": request_params
    });

    let request_frame = doubao_protocol::build_full_client_request(
        &serde_json::to_string(&client_request).unwrap(),
    );
    ws.send(tungstenite::Message::Binary(request_frame.into()))
        .await
        .map_err(|e| format!("发送请求失败: {}", e))?;

    // 等待服务端确认
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收确认失败: {}", e))?;
        if let tungstenite::Message::Binary(data) = msg {
            let resp = doubao_protocol::parse_server_response(&data)?;
            if resp.is_error {
                return Err(format!("服务端错误: {}", resp.payload));
            }
        }
    }

    // 2. 发送音频数据（直接发 PCM，不转 WAV）
    // nostream 模式下服务端等最后一包才处理，一次性发完最快
    let audio_frame = doubao_protocol::build_audio_request(&pcm_data, true);
    ws.send(tungstenite::Message::Binary(audio_frame.into()))
        .await
        .map_err(|e| format!("发送音频失败: {}", e))?;

    // 3. 接收结果（bigmodel_async 双向流式：每包输入对应一包返回，取最终结果）
    let mut final_text = String::new();

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收结果失败: {}", e))?;
        match msg {
            tungstenite::Message::Binary(data) => {
                let resp = doubao_protocol::parse_server_response(&data)?;
                if resp.is_error {
                    return Err(format!("识别错误: {}", resp.payload));
                }

                // 解析 JSON 结果，持续更新 final_text
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json.get("result").and_then(|r| r.get("text")).and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            final_text = text.to_string();
                        }
                    }
                }

                if resp.is_last {
                    break;
                }
            }
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }

    // 关闭连接
    let _ = ws.close(None).await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    Ok(AsrResult {
        text: final_text,
        elapsed_ms,
    })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let auth = DoubaoAuth::from_config(config);
    if let Some(missing) = auth.missing_field() {
        return TestResult {
            ok: false,
            message: format!("还没填{}", missing),
            elapsed_ms: 0,
            detail: String::new(),
        };
    }

    let start = Instant::now();

    match connect(&auth, "nostream test").await {
        Ok((mut ws, resource_id)) => {
            let _ = ws.close(None).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;
            TestResult {
                ok: true,
                message: format!("连接成功 ({}ms)", elapsed_ms),
                elapsed_ms,
                // 资源 ID 决定计费方式（小时版/并发版），测通了顺手告诉用户命中的是哪个
                detail: format!("资源: {}", resource_id),
            }
        }
        Err(e) => {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            TestResult {
                ok: false,
                message: e,
                elapsed_ms,
                detail: String::new(),
            }
        }
    }
}
