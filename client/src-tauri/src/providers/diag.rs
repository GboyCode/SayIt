// 各 ASR / AI 供应商的统一诊断日志。
//
// 为什么需要这个模块：有用户报「没有检测到有效声音」，而我们手上除了这句话什么都没有。
// 当时除两条 realtime 路径外，其余 provider 在失败点一条日志都不写，返回的 Err 里也没有
// 任何服务端信息（HTTP 状态、响应体、追踪 ID），空结果更是走成功路径、前后端都不留痕迹。
// 结果是排查只能靠猜和反复问用户，而真正的原因（额度耗尽、资源未开通、服务端提前关连接）
// 本来在响应里写得很清楚。
//
// 三条硬约束，改这里之前先读：
//
//   1. **只记文本长度，绝不记识别文本或校对文本。** 公开版不留「用户说了什么」的痕迹，
//      与审计只记长度的口径一致。想加 text=... 的时候请停手。
//   2. **绝不记密钥。** 只记鉴权模式名（如 api_key(new-console)）。
//   3. **截断按字符边界，不按字节。** 供应商的报错体基本都是中文，`&s[..n]` 落在多字节
//      字符中间会直接 panic —— 而这些截断只在出错路径上执行，等于「一出错就崩」，
//      把一个看得懂的错误变成一次没有日志的崩溃。

use crate::commands::system::write_log_line;

/// 统一前缀。所有 provider 日志共用一个标签，排查时 `Select-String '\[provider\]'`
/// 一次就能把整条调用链捞出来，不必知道用户用的是哪家。
const TAG: &str = "[RUST] [provider]";

/// 按**字符**边界截断，超长补省略号；顺手把控制字符换成空格。
///
/// 压平换行是为了守住「一行一条」的结构：响应体里的换行会把一条日志拆成多行，
/// 之后按行 grep 就再也对不齐了。
pub fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s
        .chars()
        .take(max_chars)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    // 只多走一个字符就能判断有没有被截断，不必再遍历整串
    if s.chars().nth(max_chars).is_some() {
        out.push('…');
    }
    out
}

/// 记一条普通事件（请求已发出、命中了哪个资源等）。
pub fn log(scope: &str, stage: &str, detail: &str) {
    if detail.is_empty() {
        write_log_line(&format!("{} {} {}", TAG, scope, stage));
    } else {
        write_log_line(&format!("{} {} {} {}", TAG, scope, stage, detail));
    }
}

/// 记一条失败，并把**原样的用户可见消息**返回，供 `?` / `map_err` 直接用：
///
/// ```ignore
/// .map_err(|e| diag::fail(SCOPE, "send_audio", format!("发送音频失败: {}", e)))?
/// ```
///
/// 刻意做成「记录 + 返回同一条」，是为了让漏记变成不可能：只要这个错误被返回过，
/// 它就一定进过日志。否则加日志这件事永远是半覆盖的 —— 总会漏掉某个 early return，
/// 而漏掉的那个偏偏就是线上真正走到的分支。
pub fn fail(scope: &str, stage: &str, user_msg: String) -> String {
    write_log_line(&format!(
        "{} {} {} FAILED {}",
        TAG,
        scope,
        stage,
        truncate(&user_msg, 400)
    ));
    user_msg
}

/// 记一条「服务端返回了空结果」。
///
/// 空结果走的是成功路径 —— 前端只会显示「未检测到有效声音」，然后什么都不记。
/// 用户明明说了两分钟话却看到这句提示时，这条日志是唯一的线索，所以务必带上服务端
/// 给的全部上下文（状态码、响应体摘要、追踪 ID）。
pub fn empty_result(scope: &str, detail: &str) {
    write_log_line(&format!("{} {} EMPTY_RESULT {}", TAG, scope, detail));
}

/// 记一次成功。**只记字符数，不记内容**（见文件头约束 1）。
pub fn ok(scope: &str, elapsed_ms: u64, text_chars: usize) {
    write_log_line(&format!(
        "{} {} ok elapsed={}ms chars={}",
        TAG, scope, elapsed_ms, text_chars
    ));
}

/// 出错时值得记下来的字段名。全是「服务端在解释为什么不行」的字段
/// （额度、资源未开通、限流、截断原因都在这里），不含任何识别内容。
const SAFE_FIELDS: &[&str] = &[
    "code",
    "error_code",
    "message",
    "msg",
    "status",
    "request_id",
    "finish_reason",
];

/// 明确排除的字段名：这些装的是识别文本 / 校对文本，一个都不能进日志。
const TEXT_FIELDS: &[&str] = &["text", "content", "transcript", "delta", "utterances"];

fn collect_safe_fields(value: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
    // 限深既防御深层嵌套的大响应，也让日志长度可控
    if depth > 4 || out.len() >= 6 {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if TEXT_FIELDS.iter().any(|t| k.eq_ignore_ascii_case(t)) {
                    continue;
                }
                // 只收标量。这一条是关键：OpenAI 兼容响应里的 `message` 是个**对象**，
                // 里面装着 content（识别/校对文本）—— 只收标量就自动把它挡在外面，
                // 同时保留 `message: "资源未开通"` 这种真正有用的字符串。
                let is_scalar = v.is_string() || v.is_number() || v.is_boolean();
                if is_scalar && SAFE_FIELDS.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                    let raw = match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    if !raw.is_empty() {
                        out.push(format!("{}={}", k, truncate(&raw, 120)));
                    }
                }
                collect_safe_fields(v, depth + 1, out);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter().take(3) {
                collect_safe_fields(v, depth + 1, out);
            }
        }
        _ => {}
    }
}

/// 描述一个 JSON 响应体，用于「拿到空结果」时留证。
///
/// **只取结构与错误字段，绝不取识别文本**（见文件头约束 1）。排查空结果要知道的是
/// 「服务端回了个什么形状、有没有说明原因」，而不是用户说了什么。
pub fn describe_json(raw: &str) -> String {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
        return format!("body_bytes={} (非 JSON)", raw.len());
    };
    let mut parts = vec![format!("body_bytes={}", raw.len())];
    if let Some(obj) = json.as_object() {
        let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        parts.push(format!("keys=[{}]", keys.join(",")));
    }
    let mut fields = Vec::new();
    collect_safe_fields(&json, 0, &mut fields);
    parts.extend(fields);
    parts.join(" ")
}

/// 供应商常用的服务端追踪 ID 头。用户报问题时带着它才能找供应商定位，没有就只能猜。
const TRACE_HEADERS: &[&str] = &[
    "X-Tt-Logid",      // 火山引擎（豆包）
    "x-request-id",    // 阿里云 DashScope / OpenAI 兼容服务通用
    "x-ds-trace-id",   // DeepSeek
    "req-id",
];

/// HTTP 响应里对排查有用的那部分：状态码 + 追踪 ID。
pub fn http_summary(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> String {
    let mut parts = vec![format!("http={}", status.as_u16())];
    for name in TRACE_HEADERS {
        if let Some(v) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            parts.push(format!("{}={}", name, v));
        }
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 关键回归：按字节切中文会 panic。历史上 doubao / ollama / qwen / mimo 四处
    /// 各有一份 `&s[..n]` 的实现，只要供应商回一段中文报错就崩 —— 而那正是出错的时刻。
    #[test]
    fn truncates_multibyte_without_panicking() {
        let body = "请求失败：资源未开通，请到控制台确认";
        // 若按字节切，7 会落在某个汉字中间
        let out = truncate(body, 7);
        assert_eq!(out, "请求失败：资源…");
    }

    #[test]
    fn keeps_short_strings_intact() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("", 10), "");
    }

    /// 恰好等长时不该加省略号。
    #[test]
    fn no_ellipsis_at_exact_length() {
        assert_eq!(truncate("abcd", 4), "abcd");
        assert_eq!(truncate("abcde", 4), "abcd…");
    }

    /// 换行必须压平，否则一条日志会被拆成多行、破坏按行 grep。
    #[test]
    fn flattens_newlines() {
        assert_eq!(truncate("a\nb\r\nc", 20), "a b  c");
    }

    /// 关键隐私回归：OpenAI 兼容响应里 `message` 是对象、`content` 装着文本，
    /// 描述响应体时一个字都不能带出来。
    #[test]
    fn describe_json_never_leaks_recognized_text() {
        let body = r#"{"choices":[{"message":{"content":"我的银行卡密码是一二三四"},
            "finish_reason":"stop"}],"request_id":"req-42"}"#;
        let out = describe_json(body);
        assert!(!out.contains("银行卡"), "识别文本泄漏进日志: {}", out);
        assert!(!out.contains("密码"), "识别文本泄漏进日志: {}", out);
        // 该带的诊断信息要带上
        assert!(out.contains("request_id=req-42"), "{}", out);
        assert!(out.contains("finish_reason=stop"), "{}", out);
    }

    /// `message` 是字符串时它就是服务端的错误说明，这种要保留。
    #[test]
    fn describe_json_keeps_scalar_message() {
        let out = describe_json(r#"{"code":45000030,"message":"资源未开通"}"#);
        assert!(out.contains("code=45000030"), "{}", out);
        assert!(out.contains("message=资源未开通"), "{}", out);
    }

    /// 顶层 text / utterances 一律不取。
    #[test]
    fn describe_json_skips_text_fields() {
        let out = describe_json(r#"{"result":{"text":"这是识别出来的句子"}}"#);
        assert!(!out.contains("识别出来"), "{}", out);
        assert!(out.contains("keys=[result]"), "{}", out);
    }

    #[test]
    fn describe_json_handles_non_json() {
        let out = describe_json("<html>502 Bad Gateway</html>");
        assert!(out.contains("非 JSON"), "{}", out);
    }
}
