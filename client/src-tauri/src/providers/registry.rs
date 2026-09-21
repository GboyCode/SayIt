// 供应商注册表 — Tauri commands 入口

use super::types::*;
use super::{
    ai_ollama, ai_openai_compat, asr_doubao, asr_doubao_stream, asr_gemini, asr_gemini_live,
    asr_groq, asr_mimo, asr_openai_chat_audio, asr_openai_compat, asr_openai_realtime,
    asr_openrouter, asr_qwen, asr_qwen_audio_stream, asr_qwen_omni,
};
use crate::error_protocol;

/// 云端 AI 校对（Tauri command）
#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    match config.provider.as_str() {
        // Groq 与智谱都是标准的 OpenAI 兼容 chat/completions，直接复用通用实现，
        // 不需要单独的文件（base_url 已带版本段 /v1、/v4，normalize_base_url 会原样保留）。
        //
        // ⚠️ 这个清单是白名单：前端 AI_PROVIDERS 里新增一家却漏了这里，用户会拿到
        // 「Unknown AI provider: xxx」，而那句话看不出问题在路由层。两处必须一起改。
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" | "groq" | "zhipu" => {
            ai_openai_compat::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
                request.text_context.as_ref(),
            )
            .await
        }
        "ollama" => {
            ai_ollama::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
                request.text_context.as_ref(),
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// 测试 AI 连接（Tauri command）
#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        // 与 cloud_polish 的清单必须一致：只加一处会出现「测试通了但校对报未知供应商」
        // 或者反过来，两种都很难从错误信息看出是路由问题。
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" | "groq" | "zhipu" => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        "ollama" => Ok(ai_ollama::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// 云端 ASR 转写（Tauri command）
#[tauri::command]
pub async fn cloud_transcribe(request: CloudTranscribeRequest) -> Result<AsrResult, String> {
    let config = &request.asr_config;
    match config.provider.as_str() {
        "doubao" => {
            asr_doubao::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "doubao_v2" => {
            asr_doubao_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen" | "aliyun" | "qwen_realtime" => {
            asr_qwen::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Qwen-Audio-3.0 流式：关掉实时字幕、以及设置页的识别测试都走这条一次性路径。
        // 用的仍是同一个 duplex 协议，只是整段音频推完再收结果。
        "qwen_audio_stream" => {
            asr_qwen_audio_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen_omni" => {
            asr_qwen_omni::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "mimo" => {
            asr_mimo::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Groq 与 OpenAI 官方共用一份 /audio/transcriptions 实现，
        // 具体打哪个域名、用哪个默认模型由 asr_groq::endpoint_for 按 provider 分。
        //
        // openai_live_transcribe 也走这里：那是它**关掉实时字幕**时的路径。
        // 流式模型（gpt-live-transcribe）在文件端点上不存在，所以 endpoint_for 给它
        // 单独一档，把模型换成 gpt-transcribe —— 用 WebSocket 传一段已经录完的音频
        // 没有任何好处，一次 HTTP 更简单也更快。
        //
        // openai_compat_transcribe 是同一套协议、地址由用户填的那一档
        // （自建 whisper.cpp / faster-whisper / FunASR、聚合网关）。
        "groq_whisper" | "openai_transcribe" | "openai_live_transcribe"
        | "openai_compat_transcribe" => {
            asr_groq::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // 「OpenAI 兼容」那张卡：协议由 asr_openai_compat 探测后再分发到上下两组之一。
        // 用户在设置里手动指定过协议时它直接照办，不探测。
        "openai_compat" => {
            asr_openai_compat::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // chat/completions + input_audio 那一套。**与上面那组不是同一个协议**，
        // 别看着都叫「OpenAI 兼容」就并过去（地址、请求体、响应形状全不一样）。
        // qwen_chat_audio 地址内置为百炼（qwen3.8-omni-flash 走这条）；
        // openai_chat_audio 是 asr_openai_compat 分发下来的内部 key。
        "qwen_chat_audio" | "openai_chat_audio" => {
            asr_openai_chat_audio::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Gemini 同理：流式那张卡关掉字幕就走文件转写，模型换回 gemini-3.5-transcribe。
        "gemini_transcribe" | "gemini_live_transcribe" => {
            asr_gemini::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // OpenRouter 是路由层：一把 key 通往多家 STT 模型，具体哪家由模型 slug 决定。
        // 它自己的 JSON 形态（input_audio + base64），不是 multipart —— 别并进上面
        // asr_groq 那一组，理由见 asr_openrouter.rs 的文件头。
        "openrouter_transcribe" => {
            asr_openrouter::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

/// 测试 ASR 连接（Tauri command）
#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "doubao" => Ok(asr_doubao::test_connection(&config).await),
        "doubao_v2" => Ok(asr_doubao_stream::test_connection(&config).await),
        "qwen" | "aliyun" | "qwen_realtime" => Ok(asr_qwen::test_connection(&config).await),
        "qwen_audio_stream" => Ok(asr_qwen_audio_stream::test_connection(&config).await),
        "qwen_omni" => Ok(asr_qwen_omni::test_connection(&config).await),
        "mimo" => Ok(asr_mimo::test_connection(&config).await),
        "groq_whisper" | "openai_transcribe" | "openai_compat_transcribe" => {
            Ok(asr_groq::test_connection(&config).await)
        }
        "qwen_chat_audio" | "openai_chat_audio" => {
            Ok(asr_openai_chat_audio::test_connection(&config).await)
        }
        "openai_compat" => Ok(asr_openai_compat::test_connection(&config).await),
        "gemini_transcribe" => Ok(asr_gemini::test_connection(&config).await),
        "openrouter_transcribe" => Ok(asr_openrouter::test_connection(&config).await),
        // 流式那两家的连通性测试打的是**流式那条连接**（而不是它们回落用的 HTTP）：
        // 这个命令要回答的是"这份配置能不能用"，而它们平时用的就是 WebSocket。
        // HTTP 那条路由设置页的识别测试覆盖（见 cloud_transcribe 的分支）。
        "openai_live_transcribe" => Ok(asr_openai_realtime::test_connection(&config).await),
        "gemini_live_transcribe" => Ok(asr_gemini_live::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}
