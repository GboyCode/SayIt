// 云 API 模式配置面板

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { getSetting, setSetting } from '@/services/store'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { isQwenOmniProvider, resolveQwenOmniModel } from '@/lib/asrModels'
import { describeProviderError } from '@/lib/errorMessages'

const ASR_PROVIDERS = [
  { value: 'doubao_v2', label: '豆包 ASR（Doubao-Seed-ASR-2.0）' },
  { value: 'qwen', label: '千问 ASR（qwen3-asr-flash）' },
  { value: 'qwen_realtime', label: '千问 ASR 流式（qwen3-asr-flash-realtime）' },
  { value: 'qwen_omni_35_plus', label: '千问 3.5 Omni Plus（qwen3.5-omni-plus，ASR+AI）' },
  { value: 'qwen_omni_35_flash', label: '千问 3.5 Omni Flash（qwen3.5-omni-flash，ASR+AI）' },
  { value: 'mimo', label: '小米 MiMo（mimo-v2.5-asr）' },
]

interface TestResult {
  ok: boolean
  message: string
  elapsed_ms: number
}

interface SaveResult {
  tone: FeedbackTone
  message: string
  detail?: string
}

const DEFAULT_OMNI_PROMPT = '你是一个语音转文字助手。请将用户的语音内容准确转写为文字，保持原意，适当添加标点符号，不要添加任何额外的解释或评论。'

const OMNI_PROMPT_POLISH = `你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。
核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。
处理规则：
1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。
2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。
3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。
4. 添加标点符号，必要时分段。中英文混合保留合理空格。
5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。
约束：不添加原文没有的内容，不改变用户核心语义；不回答、解释、总结或续写文本中提到的问题。
只输出精炼后的文本。`

const OMNI_PROMPT_PRESETS = [
  { value: DEFAULT_OMNI_PROMPT, label: '忠实转录' },
  { value: OMNI_PROMPT_POLISH, label: '口语润色' },
] as const

// 供应商按平台分组，同平台共享 API Key
function asrKeyGroup(provider: string): string {
  if (provider === 'doubao_v2' || provider === 'doubao') return 'doubao'
  if (provider === 'mimo') return 'mimo' // 小米 MiMo 用独立 api-key
  return 'qwen' // qwen, qwen_omni_flash, qwen_omni_plus 都用百炼 key
}

/** 根据供应商检查 API Key 格式，返回提示文字（空字符串表示格式正常） */
function checkAsrKeyFormat(provider: string, key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (provider === 'doubao_v2' || provider === 'doubao') {
    // 豆包 Access Token 可能包含字母、数字以及 - _ 等符号，长度也不固定，
    // 只在出现空白字符（多为粘贴时带进的空格/换行）等明显异常时提示。
    if (/\s/.test(k)) {
      return '豆包 Access Token 不应包含空格或换行，请确认是否粘贴了多余字符'
    }
  } else if (provider === 'mimo') {
    // 小米 MiMo API Key 无公开固定格式约定，不做格式校验
  } else {
    // 百炼平台 API Key：通常以 sk- 开头
    if (!/^sk-/.test(k)) {
      return '百炼 API Key 通常以 sk- 开头，请确认格式是否正确'
    }
  }
  return ''
}

/** 检查豆包 App ID 格式 */
function checkAsrAppIdFormat(appId: string): string {
  const id = appId.trim()
  if (!id) return ''
  if (!/^\d+$/.test(id)) {
    return 'App ID 通常为纯数字，请确认是否包含了多余字符'
  }
  if (id.length !== 10) {
    return `App ID 通常为 10 位数字（当前 ${id.length} 位），请确认是否正确`
  }
  return ''
}

export default function CloudAPISection() {
  // ASR 配置
  const [asrProvider, setAsrProvider] = useState('doubao_v2')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrAppId, setAsrAppId] = useState('')
  /** 已保存的凭证快照，用来判断「未保存」 */
  const [saved, setSaved] = useState({ apiKey: '', appId: '', omniPrompt: '' })
  const [asrTesting, setAsrTesting] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [omniSystemPrompt, setOmniSystemPrompt] = useState(DEFAULT_OMNI_PROMPT)
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState('')

  const isOmni = isQwenOmniProvider(asrProvider)
  const isDirty = asrApiKey !== saved.apiKey
    || asrAppId !== saved.appId
    || (isOmni && omniSystemPrompt !== saved.omniPrompt)

  // 加载指定平台的 ASR key（每个供应商分组独立，不回退到全局，避免带入其它供应商的 key）
  async function loadAsrKeys(provider: string) {
    const group = asrKeyGroup(provider)
    const apiKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
    const appId = await getSetting(`cloudAsr.${group}.appId`, '') as string
    setAsrApiKey(apiKey)
    setAsrAppId(appId)
    return { apiKey, appId }
  }

  useEffect(() => {
    void loadSettings()
    // 切走路由时复位"有未保存改动"，别把脏状态留给下一次进入
    return () => setEngineDraftDirty(false)
  }, [])

  async function loadSettings() {
    const provider = await getSetting('cloudAsr.provider', 'doubao_v2') as string
    setAsrProvider(provider)
    // 一次性迁移：老版本只有全局 key，迁到「当前供应商」的分组，升级后不丢 key，也不污染其它供应商
    const group = asrKeyGroup(provider)
    const existingGroupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
    if (!existingGroupKey) {
      const legacyKey = await getSetting('cloudAsr.apiKey', '') as string
      if (legacyKey) {
        await setSetting(`cloudAsr.${group}.apiKey`, legacyKey)
        await setSetting(`cloudAsr.${group}.appId`, await getSetting('cloudAsr.appId', '') as string)
      }
    }
    const loaded = await loadAsrKeys(provider)
    const prompt = await getSetting('cloudAsr.omniSystemPrompt', DEFAULT_OMNI_PROMPT) as string
    setOmniSystemPrompt(prompt)
    setSaved({ apiKey: loaded.apiKey, appId: loaded.appId, omniPrompt: prompt })
    setEngineDraftDirty(false)
    setQwenWorkspaceId(await getSetting('cloudAsr.qwen.workspaceId', '') as string)
  }

  /** 业务空间 ID 是选填项且即改即存，不参与「未保存」判断 */
  function handleQwenWorkspaceIdChange(v: string) {
    setQwenWorkspaceId(v)
    void setSetting('cloudAsr.qwen.workspaceId', v.trim())
  }

  function markDirty(next: { apiKey?: string; appId?: string; omniPrompt?: string }) {
    setResult(null)
    const apiKey = next.apiKey ?? asrApiKey
    const appId = next.appId ?? asrAppId
    const omniPrompt = next.omniPrompt ?? omniSystemPrompt
    setEngineDraftDirty(
      apiKey !== saved.apiKey
      || appId !== saved.appId
      || (isOmni && omniPrompt !== saved.omniPrompt),
    )
  }

  // 切换供应商时自动保存 provider 并加载对应平台的 key，同步到全局 key
  function handleAsrProviderChange(newProvider: string) {
    setAsrProvider(newProvider)
    setResult(null)
    void (async () => {
      await setSetting('cloudAsr.provider', newProvider)
      const group = asrKeyGroup(newProvider)
      const groupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
      const groupAppId = await getSetting(`cloudAsr.${group}.appId`, '') as string
      // 只显示该供应商自己的 key（未配置则为空），并同步到全局供运行时读取，
      // 空也要写空，避免把上一个供应商的 key 带过来。
      setAsrApiKey(groupKey)
      setAsrAppId(groupAppId)
      setSaved((prev) => ({ ...prev, apiKey: groupKey, appId: groupAppId }))
      setEngineDraftDirty(false)
      await setSetting('cloudAsr.apiKey', groupKey)
      await setSetting('cloudAsr.appId', groupAppId)
      void refreshModeStatus() // 同步左下角与页面右上角的就绪指示
    })()
  }

  /**
   * 保存并测试。
   *
   * 按钮原来在 `!asrApiKey` 时禁用，导致用户无法清空一个填错的密钥；文案也只写「保存」，
   * 用户按下去之前不知道自己会触发一次联网请求。现在：有密钥 = 保存并试拨一次，
   * 没密钥 = 只保存（等于清空），两种情况都给明确反馈。
   */
  async function saveAndTestAsr() {
    if (asrTesting) return // 防止双击重复触发
    setAsrTesting(true)
    setResult(null)

    // 先保存（互相独立，并行写入而非依次 await）
    const group = asrKeyGroup(asrProvider)
    const savePromises = [
      setSetting(`cloudAsr.${group}.apiKey`, asrApiKey),
      setSetting(`cloudAsr.${group}.appId`, asrAppId),
      setSetting('cloudAsr.apiKey', asrApiKey),
      setSetting('cloudAsr.appId', asrAppId),
    ]
    if (isOmni) {
      savePromises.push(setSetting('cloudAsr.omniSystemPrompt', omniSystemPrompt))
    }
    await Promise.all(savePromises)
    setSaved({ apiKey: asrApiKey, appId: asrAppId, omniPrompt: omniSystemPrompt })
    setEngineDraftDirty(false)
    void refreshModeStatus()

    if (!asrApiKey.trim()) {
      setResult({ tone: 'warning', message: '已清空密钥。填入密钥后才能使用云 API 模式。' })
      setAsrTesting(false)
      return
    }

    // 再测试
    try {
      const qwenOmniModel = resolveQwenOmniModel(asrProvider)
      const testResult = await invoke<TestResult>('test_asr_connection', {
        config: {
          provider: isOmni ? 'qwen_omni' : asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(isOmni && { extra: { model: qwenOmniModel } }),
        },
      })
      if (testResult.ok) {
        setResult({ tone: 'success', message: `已保存，密钥可用（${testResult.elapsed_ms} ms）。` })
      } else {
        const friendly = describeProviderError(testResult.message)
        setResult({ tone: 'error', message: `已保存，但测试没通过：${friendly.message}`, detail: friendly.detail })
      }
    } catch (err) {
      const friendly = describeProviderError(err)
      setResult({ tone: 'error', message: `已保存，但测试没通过：${friendly.message}`, detail: friendly.detail })
    } finally {
      setAsrTesting(false)
    }
  }

  const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
  const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm transition-colors focus:border-input-focus-border'
  const keyLabel = asrProvider === 'doubao_v2' ? 'Access Token' : 'API Key'

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-1 text-lg font-semibold">语音识别 (ASR)</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          推荐使用豆包 ASR 进行语音识别，准确率高，速度快。
        </p>
        <div className="space-y-3">
          <div>
            <label htmlFor="asr-provider" className="mb-1 block text-sm text-muted-foreground">供应商</label>
            <select
              id="asr-provider"
              value={asrProvider}
              onChange={(e) => handleAsrProviderChange(e.target.value)}
              className={selectClass}
            >
              {ASR_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* 只有豆包需要 App ID；千问（含流式/Omni）和 MiMo 只需要 API Key */}
          {asrProvider === 'doubao_v2' && (
            <div>
              <label htmlFor="asr-app-id" className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                id="asr-app-id"
                value={asrAppId}
                onChange={(e) => { setAsrAppId(e.target.value); markDirty({ appId: e.target.value }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveAndTestAsr() }}
                placeholder="输入 App ID（豆包需要）"
                className={inputClass}
              />
              {checkAsrAppIdFormat(asrAppId) && <FormatHint text={checkAsrAppIdFormat(asrAppId)} />}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center gap-2">
              <label htmlFor="asr-api-key" className="text-sm text-muted-foreground">{keyLabel}</label>
              {/* 密钥只活在 local state 里，切页就没了；原来这件事完全无提示 */}
              {isDirty && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-strong">
                  未保存
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[14rem] flex-1">
                <PasswordInput
                  id="asr-api-key"
                  label={keyLabel}
                  value={asrApiKey}
                  onChange={(v) => { setAsrApiKey(v); markDirty({ apiKey: v }) }}
                  onSubmit={() => void saveAndTestAsr()}
                  placeholder={asrProvider === 'doubao_v2' ? '输入火山引擎 Access Token' : asrProvider === 'mimo' ? '输入小米 MiMo API Key' : '输入百炼平台 API Key'}
                  className={inputClass}
                />
              </div>
              <Button
                size="sm"
                className="h-9 shrink-0"
                onClick={() => void saveAndTestAsr()}
                disabled={asrTesting}
              >
                {asrTesting ? '保存并测试中…' : '保存并测试'}
              </Button>
            </div>
            {!result && checkAsrKeyFormat(asrProvider, asrApiKey) && (
              <FormatHint text={checkAsrKeyFormat(asrProvider, asrApiKey)} />
            )}
            {result && (
              <Feedback className="mt-2" tone={result.tone} message={result.message} detail={result.detail} />
            )}
          </div>

          {asrProvider === 'qwen_realtime' && (
            <div>
              <label htmlFor="qwen-workspace-id" className="mb-1 block text-sm text-muted-foreground">
                业务空间 ID（选填）
              </label>
              <PasswordInput
                id="qwen-workspace-id"
                label="业务空间 ID"
                value={qwenWorkspaceId}
                onChange={handleQwenWorkspaceIdChange}
                placeholder="如 ws-xxxxxxxx"
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                使用「流式实时字幕」功能需填入此 ID，否则可留空。登录
                <button
                  type="button"
                  onClick={() => void shellOpen('https://bailian.console.aliyun.com')}
                  className="mx-0.5 inline-flex items-center gap-0.5 text-primary underline underline-offset-2 decoration-primary/50 transition-colors hover:decoration-primary"
                >
                  百炼控制台
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
                后，鼠标移到右上角「默认业务空间」即可查看。
              </p>
            </div>
          )}

          {isOmni && (
            <div>
              <label htmlFor="omni-system-prompt" className="mb-1.5 block text-sm text-muted-foreground">
                System Prompt
              </label>
              <Segmented
                className="mb-1.5"
                label="System Prompt 预设"
                size="sm"
                value={omniSystemPrompt}
                options={OMNI_PROMPT_PRESETS}
                onChange={(v) => { setOmniSystemPrompt(v); markDirty({ omniPrompt: v }) }}
              />
              <textarea
                id="omni-system-prompt"
                value={omniSystemPrompt}
                onChange={(e) => { setOmniSystemPrompt(e.target.value); markDirty({ omniPrompt: e.target.value }) }}
                placeholder={DEFAULT_OMNI_PROMPT}
                rows={2}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm transition-colors focus:border-input-focus-border"
              />
            </div>
          )}

          {isOmni && (
            // 这条提示原来写的是「无需再单独配置下方的「AI 校对」」——「下方」没有 AI 校对，
            // 页面拆分后它搬到了侧栏另一页，用户会往下滚着找一个不存在的东西。
            <Feedback
              tone="info"
              message="这个模型自己就能听懂并整理，语音识别和 AI 整理一步完成。侧栏「AI 整理」里的供应商配置对它不生效，不用再单独填。"
            />
          )}

          {asrProvider === 'doubao_v2' && (
            <button
              type="button"
              onClick={() => void shellOpen('https://my.feishu.cn/wiki/V4vLw2UfDiWcATkK2dyckhvynzc')}
              className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary"
            >
              SayIt 语音识别配置
              <ExternalLink className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
