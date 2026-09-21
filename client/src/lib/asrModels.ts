/**
 * ASR 供应商 key → 实际模型 ID 映射
 */

const QWEN_OMNI_MODEL_MAP: Record<string, string> = {
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
}

/** 判断是否为 Qwen Omni 系列模型 */
export function isQwenOmniProvider(provider: string): boolean {
  return provider.startsWith('qwen_omni')
}

/** 根据供应商 key 解析 Qwen Omni 模型 ID，非 Omni 返回 undefined */
export function resolveQwenOmniModel(provider: string): string | undefined {
  return QWEN_OMNI_MODEL_MAP[provider]
}

/** ASR 供应商 key → 显示用的**默认**模型 ID（用户可能选了同平台的另一个） */
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  qwen: 'qwen3-asr-flash',
  qwen_realtime: 'qwen3-asr-flash-realtime',
  qwen_audio_stream: 'qwen-audio-3.0-asr-flash-streaming',
  mimo: 'mimo-v2.5-asr',
  groq_whisper: 'whisper-large-v3-turbo',
  openai_transcribe: 'gpt-transcribe',
  openai_live_transcribe: 'gpt-live-transcribe',
  gemini_transcribe: 'gemini-3.5-transcribe',
  gemini_live_transcribe: 'gemini-3.5-transcribe-live',
  openrouter_transcribe: 'openai/gpt-transcribe',
  ...QWEN_OMNI_MODEL_MAP,
}

/**
 * 将内部供应商 key 映射为显示用的模型名称。
 *
 * `selectedModel` 传的是运行时键 `cloudAsr.model`（用户在服务配置里选的那个）。
 * 只有 Groq / OpenAI 这类同协议多模型的服务会有值，其余一律走上面的默认表 ——
 * 不接这个参数的话，诊断和测试结果里显示的模型会和真正发出去的那个不是一个。
 */
export function resolveAsrDisplayModel(providerKey: string, selectedModel?: string): string {
  const picked = selectedModel?.trim()
  if (picked) return picked
  return ASR_DISPLAY_MODEL_MAP[providerKey] || providerKey || 'unknown'
}

/**
 * asr_config.extra 里我们会用到的字段。
 *
 * 继承 Record 是为了能直接赋给 `AsrProviderConfig.extra`（那边声明的是任意键值，
 * 因为每家供应商往里放的东西不同）。这里把用得上的两个字段显式列出来，
 * 好让拼错字段名当场报错，而不是静默变成一个后端读不到的键。
 */
export interface AsrConfigExtra extends Record<string, unknown> {
  model?: string
  instructions?: string
  /** 自定义端点地址。空 = 用实现里内置的官方地址 */
  baseUrl?: string
  /**
   * 「OpenAI 兼容」那张卡说哪种协议：`transcriptions` / `chat`。
   * 不带这个字段 = 让 Rust 侧自己探测（默认的 `auto` 就不往下传）。
   */
  protocol?: string
}

/**
 * 组 `asr_config.extra` —— 「这次用哪个模型」的唯一出处。
 *
 * 四个地方要组 asr_config（录音主链路、历史重跑、设置页识别测试、诊断页测试），
 * 以前每处都自己拼一遍 extra，于是加一个「可选模型」就得改四处、还容易漏掉一处 ——
 * 漏掉的那处会静默用回默认模型，而用户以为自己换了。
 *
 * ⚠️ 这里**不再**根据 provider 去反查 Omni 的模型名。改成「一张卡 = 一个平台」之后，
 * 模型由 `resolveAsrApiModel` 解析好再传进来，而运行时 provider 变成了 `qwen_omni`
 * 这个平台级的值 —— 老代码拿它去查 QWEN_OMNI_MODEL_MAP 查不到，于是
 * `extra.model` 是 undefined，后端回落到自己的默认模型。表现是**下拉里选哪个
 * Omni 都跑同一个**（都变成 qwen3-omni-flash-realtime），而界面显示得一切正常。
 * 老表只作为存量运行时键的兜底保留（那时 provider 还是 `qwen_omni_35_plus` 这类）。
 */
export function buildAsrExtra(
  provider: string,
  options: {
    model?: string
    instructions?: string
    baseUrl?: string
    protocol?: string
  } = {},
): AsrConfigExtra | undefined {
  const model = options.model?.trim() || resolveQwenOmniModel(provider) || ''
  const instructions = options.instructions?.trim() ?? ''
  const baseUrl = options.baseUrl?.trim() ?? ''
  // `auto` 不往下传：Rust 侧「没有这个字段」和「auto」是同一个意思，
  // 少传一个字段就少一处两边要对齐的约定。
  const protocol = options.protocol?.trim() ?? ''
  const explicitProtocol = protocol === 'auto' ? '' : protocol
  if (!model && !instructions && !baseUrl && !explicitProtocol) return undefined
  return {
    ...(model ? { model } : {}),
    ...(instructions ? { instructions } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(explicitProtocol ? { protocol: explicitProtocol } : {}),
  }
}

/**
 * 有流式实现的供应商（不含运行时前置条件）。
 *
 * 注意 qwen3-asr-flash（`qwen`）与 `openai_transcribe` / `gemini_transcribe` 都是
 * 一次性 HTTP 模型，不在此列 —— 它们对应的流式版本是各自单独的一张卡。
 */
const STREAMING_CAPABLE = new Set([
  'doubao_v2',
  'qwen_realtime',
  'qwen_audio_stream',
  'openai_live_transcribe',
  'gemini_live_transcribe',
])

export function isStreamingDisplayCapable(provider: string): boolean {
  return STREAMING_CAPABLE.has(provider)
}

/**
 * 判断当前配置下「流式实时显示」是否真正就绪可用（含运行时前置条件）。
 *
 * **这是运行时唯一的闸门**（CloudAPIProvider 拿它决定走不走 WebSocket），
 * 光在服务目录里给一条加 `streaming: true` 是没有任何效果的。
 *
 * - doubao_v2：直接可用（需在火山开通「流式语音识别 2.0」，运行时由服务端校验）。
 * - qwen_audio_stream（qwen-audio-3.0-asr-flash-streaming）：直接可用。这个模型
 *   **不需要 WorkspaceId** —— 通用域名 dashscope.aliyuncs.com 实测可用，
 *   别照抄下面那条的前置条件（见 providers/asr_qwen_audio_stream.rs 文件头的实测记录）。
 * - qwen_realtime（qwen3-asr-flash-realtime）：走地域专属实时端点，必须提供北京业务空间 WorkspaceId 才可用。
 * - openai_live_transcribe / gemini_live_transcribe：填了密钥就能用，没有额外前置条件。
 * - qwen（qwen3-asr-flash）：非实时模型，不支持实时字幕。
 */
export function isStreamingDisplayReady(provider: string, qwenWorkspaceId?: string): boolean {
  if (provider === 'qwen_realtime') {
    return Boolean(qwenWorkspaceId && qwenWorkspaceId.trim())
  }
  return isStreamingDisplayCapable(provider)
}
