// 云 API 模式配置面板 —— 一张卡 = 一份语音识别服务配置
//
// 结构与「AI 服务」页对齐（同一套卡片、同一套弹窗、同一套状态语义）：可以新建多份，
// 同一家也能存多份（两个百炼账号、两套豆包密钥），点一张即启用。
//
// 与 AI 服务的唯一实质差别：供应商从内置清单里选，不能填任意地址 —— 每家 ASR 的协议
// 都要一份专门的 Rust 实现，不像 AI 整理那边只要 OpenAI 兼容端点就能接。
//
// 「同平台重复粘密钥」不靠把凭据提到平台级来解决（那样一张卡就不再是一份完整配置、
// 也没法存两个账号），而是照 AI 服务的做法：新建时自动沿用同平台上一份的密钥，
// 并在界面上说明它从哪来。

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { CheckCircle2, ExternalLink, Info, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { resolveQwenOmniModel } from '@/lib/asrModels'
import { describeProviderError } from '@/lib/errorMessages'
import { doubaoKeyLabel } from '@/lib/cloudAsrCreds'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  describeAsrMissing,
  effectiveAsrCredentials,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  keyFingerprint,
  type AsrCheck,
  type AsrProfile,
} from './asrProviderCatalog'
import { loadAsrProfiles, saveAsrProfiles } from './asrProfileStore'
import { formatCheckedAt, formatLatency, isCheckFresh } from './aiProviderCatalog'

const DOC_URL = 'https://my.feishu.cn/wiki/V4vLw2UfDiWcATkK2dyckhvynzc'

const DOUBAO_CONSOLE_OPTIONS = [
  { value: 'new', label: '新版控制台' },
  { value: 'legacy', label: '旧版控制台' },
] as const

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

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm transition-colors focus:border-input-focus-border'
const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'
const cardIconButtonClass = 'pointer-events-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
}

/** 卡片标题：同一家有多份时补上密钥尾巴，否则两张卡长得一模一样 */
function profileTitle(profile: AsrProfile, siblings: number): string {
  const entry = findAsrProvider(profile.provider)
  const base = entry?.label ?? profile.provider
  if (siblings <= 1) return base
  const fp = keyFingerprint(profile)
  return fp ? `${base} ${fp}` : base
}

export default function CloudAPISection() {
  const [profiles, setProfiles] = useState<AsrProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState('')

  /** 正在编辑的那份（新建也走这里）。null = 弹窗关着 */
  const [draft, setDraft] = useState<AsrProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)

  const busy = testingId !== '' || saving
  const draftEntry = draft ? findAsrProvider(draft.provider) : undefined
  const draftPlatform = draftEntry?.platform ?? 'doubao'
  const draftIsDoubao = draftPlatform === 'doubao'
  const draftDirty = draft !== null && JSON.stringify(draft) !== draftBaseline
  /**
   * 密钥是不是从同平台上一份带过来的。
   * 用「当前值是否还等于那份的密钥」判断：用户一改成别的，这句提示自己就消失。
   */
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOfPlatform(draft.provider, draft.id)?.apiKey === draft.apiKey

  useEffect(() => {
    void load()
    return () => setEngineDraftDirty(false)
  }, [])

  async function load() {
    const state = await loadAsrProfiles()
    setProfiles(state.profiles)
    setActiveId(state.activeId)
    setLoaded(true)
  }

  /** 同平台最近一份配置，用来在新建时沿用密钥 */
  function lastProfileOfPlatform(providerId: string, excludeId?: string): AsrProfile | undefined {
    const platform = findAsrProvider(providerId)?.platform
    if (!platform) return undefined
    return [...profiles]
      .reverse()
      .find((p) => p.id !== excludeId && findAsrProvider(p.provider)?.platform === platform)
  }

  async function persist(next: AsrProfile[], nextActiveId: string) {
    setProfiles(next)
    setActiveId(nextActiveId)
    await saveAsrProfiles({ profiles: next, activeId: nextActiveId })
    void refreshModeStatus()
  }

  async function handleActivate(id: string) {
    if (id === activeId) return
    setNotice(null)
    await persist(profiles, id)
  }

  // ─────────────────────── 测试 ───────────────────────

  /**
   * 用内置测试音频真跑一次识别。
   *
   * 为什么不用更便宜的 test_asr_connection：那个只做握手鉴权，握手过了识别仍可能失败
   * （资源没开通、额度用尽），而且它测不出耗时。这一页要回答「哪个更快」，
   * 就得测真实转写。代价是一次真实计费调用，页面上写明了。
   */
  async function handleTest(profile: AsrProfile) {
    if (busy) return
    const entry = findAsrProvider(profile.provider)
    if (!entry) return
    const missing = describeAsrMissing(profile)
    if (missing) {
      setNotice({ tone: 'warning', message: `${entry.label}：${missing}，先编辑这份配置再测。` })
      return
    }
    setTestingId(profile.id)
    setNotice(null)
    try {
      const wavB64 = await invoke<string>('get_test_audio_b64')
      const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
      const pcmBytes = wavBytes.slice(44) // 去掉 44 字节 WAV 头，后端要的是裸 PCM
      const audioSec = pcmBytes.length / 2 / 16000
      let pcmB64 = ''
      const chunk = 8192
      for (let i = 0; i < pcmBytes.length; i += chunk) {
        pcmB64 += String.fromCharCode(...pcmBytes.subarray(i, Math.min(i + chunk, pcmBytes.length)))
      }
      pcmB64 = btoa(pcmB64)

      const creds = effectiveAsrCredentials(profile)
      const omniModel = resolveQwenOmniModel(profile.provider)
      const start = performance.now()
      const r = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
        request: {
          audio_b64: pcmB64,
          sample_rate: 16000,
          asr_config: {
            provider: entry.omni ? 'qwen_omni' : profile.provider,
            api_key: creds.apiKey,
            app_id: creds.appId,
            ...(entry.omni && {
              extra: { model: omniModel, instructions: profile.omniPrompt || undefined },
            }),
          },
        },
      })
      const latencyMs = Math.round(performance.now() - start)
      const text = r.text.trim()
      const check: AsrCheck = text
        ? { ok: true, at: Date.now(), latencyMs, audioSec }
        // 连通了但一个字都没出：多半是资源没开通或额度问题，不能算可用
        : { ok: false, at: Date.now(), reason: '返回了空文本' }
      await persist(profiles.map((p) => (p.id === profile.id ? { ...p, check } : p)), activeId)

      if (!text) {
        setNotice({ tone: 'error', message: `${entry.label} 连通了，但没返回任何文字，请检查资源是否已开通。` })
        return
      }
      const grade = gradeAsrLatency(latencyMs, audioSec)
      setNotice({
        tone: grade.tone === 'bad' ? 'warning' : 'success',
        message: `${entry.label} 可用，转写 ${audioSec.toFixed(1)}s 音频用了 ${formatLatency(latencyMs)}（${grade.label}）。`,
        detail: `识别结果：${text}`,
      })
    } catch (err) {
      const friendly = describeProviderError(err)
      await persist(
        profiles.map((p) => (p.id === profile.id
          ? { ...p, check: { ok: false, at: Date.now(), reason: friendly.message } }
          : p)),
        activeId,
      )
      setNotice({ tone: 'error', message: `${entry.label} 测试没通过：${friendly.message}`, detail: friendly.detail })
    } finally {
      setTestingId('')
    }
  }

  // ─────────────────────── 新建 / 编辑 ───────────────────────

  function openEditor(profile: AsrProfile, isNew: boolean) {
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftBaseline(JSON.stringify(profile))
    setNotice(null)
  }

  function handleNew() {
    const fresh = emptyAsrProfile()
    // 同平台已有配置时把密钥带过来：最常见的一次操作是「同一个账号、换个模型再存一份」，
    // 否则又要回控制台复制粘贴一遍
    const prev = lastProfileOfPlatform(fresh.provider, fresh.id)
    if (prev) {
      fresh.apiKey = prev.apiKey
      fresh.otherKey = prev.otherKey
      fresh.appId = prev.appId
      fresh.console = prev.console
      fresh.workspaceId = prev.workspaceId
    }
    fresh.omniPrompt = DEFAULT_OMNI_PROMPT
    openEditor(fresh, true)
  }

  function closeEditor() {
    if (saving) return
    setDraft(null)
    setEngineDraftDirty(false)
  }

  function patchDraft(next: Partial<AsrProfile>) {
    if (!draft) return
    const merged = { ...draft, ...next }
    setDraft(merged)
    setEngineDraftDirty(JSON.stringify(merged) !== draftBaseline)
  }

  /** 换供应商：跨平台时清掉不属于新平台的凭据，并沿用新平台已有的密钥 */
  function handleDraftProvider(providerId: string) {
    if (!draft) return
    const nextPlatform = findAsrProvider(providerId)?.platform
    const prevPlatform = findAsrProvider(draft.provider)?.platform
    if (nextPlatform === prevPlatform) {
      patchDraft({ provider: providerId })
      return
    }
    // 平台变了，旧密钥对新家没有意义 —— 留着只会被当成"已配置"而实际发不出去
    const prev = lastProfileOfPlatform(providerId, draft.id)
    patchDraft({
      provider: providerId,
      apiKey: prev?.apiKey ?? '',
      otherKey: prev?.otherKey ?? '',
      appId: prev?.appId ?? '',
      console: prev?.console ?? 'new',
      workspaceId: prev?.workspaceId ?? '',
    })
  }

  /** 切换豆包控制台代次：把当前密钥留给这一代，取出另一代的填进来 */
  function switchConsole(next: string) {
    if (!draft || (next !== 'new' && next !== 'legacy')) return
    if (next === draft.console) return
    patchDraft({ console: next, apiKey: draft.otherKey, otherKey: draft.apiKey })
  }

  async function handleSaveDraft() {
    if (!draft || saving) return
    setSaving(true)
    try {
      // 改过凭据就把旧结论作废：否则卡上那枚用旧 key 测出来的「可用」还挂着，
      // 等于拿过期结论替新配置作保
      const before = profiles.find((p) => p.id === draft.id)
      const credsChanged = !before
        || JSON.stringify(effectiveAsrCredentials(before)) !== JSON.stringify(effectiveAsrCredentials(draft))
      const saved: AsrProfile = { ...draft, check: credsChanged ? undefined : before?.check }

      const next = draftIsNew
        ? [...profiles, saved]
        : profiles.map((p) => (p.id === saved.id ? saved : p))
      // 新建的那份直接启用：用户刚配好它，多半就是想用它
      await persist(next, draftIsNew ? saved.id : activeId)

      setDraft(null)
      setEngineDraftDirty(false)
      const missing = describeAsrMissing(saved)
      setNotice(missing
        ? { tone: 'warning', message: `已保存，但${missing}。` }
        : { tone: 'success', message: '已保存，点卡片上的测试按钮验证一下。' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    // 删掉的正好是启用中的那份时，让 resolveActiveAsrProfile 回落到第一条
    await persist(next, id === activeId ? (next[0]?.id ?? '') : activeId)
    setPendingDeleteId('')
    setNotice(null)
  }

  // ─────────────────────── 卡片 ───────────────────────

  interface CardStatus {
    label: string
    tone: 'neutral' | 'ok' | 'warn' | 'bad'
    spoken: string
    hint: string
    /**
     * 这张卡还缺配置。
     * 单独一个标志而不是复用 tone === 'warn'：延迟「偏慢」也是 warn，
     * 但那不需要用户去填任何东西，按钮不必常驻。
     */
    needsSetup?: boolean
  }

  function describeCard(profile: AsrProfile): CardStatus {
    if (testingId === profile.id) {
      return { label: '测试中', tone: 'neutral', spoken: '正在测试', hint: '正在用测试音频跑一次识别' }
    }
    const missing = describeAsrMissing(profile)
    if (missing) {
      return { label: '待配置', tone: 'warn', spoken: missing, hint: missing, needsSetup: true }
    }
    const entry = findAsrProvider(profile.provider)
    if (entry?.needsWorkspaceId && !profile.workspaceId.trim()) {
      return {
        label: '缺空间 ID',
        tone: 'warn',
        spoken: '还没填业务空间 ID',
        hint: '流式识别需要百炼「业务空间 ID」，在这份配置里一起填',
        needsSetup: true,
      }
    }
    const check = profile.check
    if (!check) {
      return { label: '未测试', tone: 'neutral', spoken: '尚未测试', hint: '还没测过，点测试按钮验证可用性与速度' }
    }
    if (!check.ok) {
      return {
        label: '不可用',
        tone: 'bad',
        spoken: `不可用：${check.reason ?? '未知原因'}`,
        hint: `${formatCheckedAt(check.at)}测试：${check.reason ?? '未知原因'}`,
      }
    }
    const fresh = isCheckFresh(check)
    const ms = check.latencyMs
    if (ms === undefined) {
      return { label: '可用', tone: fresh ? 'ok' : 'neutral', spoken: '可用', hint: `${formatCheckedAt(check.at)}测试通过` }
    }
    const grade = gradeAsrLatency(ms, check.audioSec ?? 0)
    return {
      label: formatLatency(ms),
      // 结论过期就把颜色收回中性：绿色只代表「刚刚验过，可以信」
      tone: fresh ? grade.tone : 'neutral',
      spoken: `可用 · ${grade.label} ${formatLatency(ms)}`,
      hint: `${formatCheckedAt(check.at)}测试：转写 ${(check.audioSec ?? 0).toFixed(1)}s 音频用了 ${formatLatency(ms)}（${grade.label}）${fresh ? '' : '，结论已超过 24 小时，建议重测'}`,
    }
  }

  const chipToneClass: Record<CardStatus['tone'], string> = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-success/10 text-success-strong',
    warn: 'bg-warning/10 text-warning-strong',
    bad: 'bg-destructive/10 text-destructive',
  }

  function renderCard(profile: AsrProfile) {
    const entry = findAsrProvider(profile.provider)
    if (!entry) return null
    const isActive = profile.id === activeId
    const status = describeCard(profile)
    const siblings = profiles.filter((p) => p.provider === profile.provider).length
    const title = profileTitle(profile, siblings)
    return (
      <div
        key={profile.id}
        className={cn(
          'group relative rounded-lg border p-2.5 transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        )}
      >
        {/* 铺满整卡的单选按钮：卡上还有自己的图标按钮，不能把整张卡做成 <button>
            （按钮套按钮，读屏和键盘都会错） */}
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          aria-label={`${title}（${entry.model}）·${status.spoken}`}
          onClick={() => void handleActivate(profile.id)}
          className="absolute inset-0 rounded-lg"
        />
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Tooltip className="pointer-events-auto relative z-10 shrink-0" content="使用中">
              <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label="使用中" />
            </Tooltip>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
          <Tooltip className="pointer-events-auto relative z-10 shrink-0" variant="light" content={status.hint}>
            <span className={cn('cursor-help rounded-full px-2 py-0.5 text-[11px] font-medium', chipToneClass[status.tone])}>
              {status.label}
            </span>
          </Tooltip>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={entry.model}>
            {entry.model}
          </span>
          {/* 待配置的卡片按钮常驻：它正在等用户去填东西，把唯一的入口藏进 hover
              等于让人对着一张没有可点之处的卡发呆。配好之后回到 hover 显隐 */}
          <div
            className={cn(
              'pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              status.needsSetup ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Tooltip className="pointer-events-auto" content="测试">
              <button
                type="button"
                onClick={() => void handleTest(profile)}
                disabled={busy}
                aria-label={`测试 ${title} 是否可用`}
                className={cardIconButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', testingId === profile.id && 'animate-spin')} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content="编辑">
              <button
                type="button"
                onClick={() => openEditor({ ...profile }, false)}
                aria-label={`编辑 ${title}`}
                className={cardIconButtonClass}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content="删除">
              <button
                type="button"
                onClick={() => setPendingDeleteId(profile.id)}
                disabled={busy}
                aria-label={`删除 ${title}`}
                className={cardIconButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {entry.blurb}
        </p>
      </div>
    )
  }

  // ─────────────────────── 弹窗 ───────────────────────

  function renderEditor() {
    if (!draft) return null
    const platformInfo = ASR_PLATFORMS[draftPlatform]
    const keyLabel = draftIsDoubao ? doubaoKeyLabel(draft.console) : 'API Key'
    return (
      <Modal
        title={draftIsNew ? '新建语音识别服务' : '编辑语音识别服务'}
        onClose={closeEditor}
        locked={saving}
        showCloseButton
        panelClassName="w-[520px]"
      >
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="asr-provider" className="mb-1 block text-sm text-muted-foreground">供应商</label>
            <select
              id="asr-provider"
              value={draft.provider}
              onChange={(e) => handleDraftProvider(e.target.value)}
              className={selectClass}
            >
              {ASR_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label} · {p.model}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{findAsrProvider(draft.provider)?.blurb}</p>
          </div>

          {draftIsDoubao && (
            <div>
              <label className="mb-1.5 block text-sm text-muted-foreground">控制台版本</label>
              <Segmented
                label="火山引擎控制台版本"
                size="sm"
                value={draft.console}
                options={DOUBAO_CONSOLE_OPTIONS}
                onChange={switchConsole}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {draft.console === 'new'
                  ? '控制台只给了一个 API Key（APP Key）时选这个，不需要 App ID。'
                  : '控制台给的是 App ID + Access Token 两样时选这个。'}
              </p>
            </div>
          )}

          {draftIsDoubao && draft.console === 'legacy' && (
            <div>
              <label htmlFor="asr-app-id" className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                id="asr-app-id"
                value={draft.appId}
                onChange={(e) => patchDraft({ appId: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder="输入 App ID"
                className={inputClass}
              />
              {draft.appId.trim() && !/^\d+$/.test(draft.appId.trim()) && (
                <FormatHint text="App ID 通常为纯数字，请确认是否包含了多余字符" />
              )}
            </div>
          )}

          {/* data-modal-autofocus：弹窗打开时焦点落在密钥上（这才是要干的事），
              而不是第一个可聚焦元素 */}
          <div data-modal-autofocus>
            <label htmlFor="asr-api-key" className="mb-1 block text-sm text-muted-foreground">{keyLabel}</label>
            <PasswordInput
              id="asr-api-key"
              label={keyLabel}
              value={draft.apiKey}
              onChange={(v) => patchDraft({ apiKey: v })}
              onSubmit={() => void handleSaveDraft()}
              placeholder={`粘贴${platformInfo.label}的${keyLabel}`}
              className={inputClass}
            />
            {/\s/.test(draft.apiKey) && (
              <FormatHint text="密钥不应包含空格或换行，请确认是否粘贴了多余字符" />
            )}
            {draftPlatform === 'qwen' && draft.apiKey.trim() && !/^sk-/.test(draft.apiKey.trim()) && (
              <FormatHint text="百炼 API Key 通常以 sk- 开头，请确认格式是否正确" />
            )}
            {/* 密钥不是凭空出现的：说一句它从哪来，免得用户以为自己看错了 */}
            {draftKeyInherited && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                已沿用同一平台上一份配置的密钥，换个服务即可；要用另一个账号就改掉它。
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => void shellOpen(platformInfo.consoleUrl)} className={linkClass}>
                打开{platformInfo.label}控制台
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
              <button type="button" onClick={() => void shellOpen(DOC_URL)} className={linkClass}>
                怎么申请密钥？看配置文档
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </div>

          {draftEntry?.needsWorkspaceId && (
            <div>
              <label htmlFor="qwen-workspace-id" className="mb-1 block text-sm text-muted-foreground">
                业务空间 ID
              </label>
              <PasswordInput
                id="qwen-workspace-id"
                label="业务空间 ID"
                value={draft.workspaceId}
                onChange={(v) => patchDraft({ workspaceId: v })}
                placeholder="如 ws-xxxxxxxx"
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                流式识别走地域专属端点，必须填这个才能用。登录百炼控制台后，
                鼠标移到右上角「默认业务空间」即可查看。
              </p>
            </div>
          )}

          {/* Omni 是「识别 + 整理」一体的模型，System Prompt 决定它整理成什么样，
              属于这份服务自己的行为，所以放在这份配置里 */}
          {draftEntry?.omni && (
            <div>
              <label htmlFor="omni-system-prompt" className="mb-1.5 block text-sm text-muted-foreground">
                System Prompt
              </label>
              <Segmented
                className="mb-1.5"
                label="System Prompt 预设"
                size="sm"
                value={draft.omniPrompt}
                options={OMNI_PROMPT_PRESETS}
                onChange={(v) => patchDraft({ omniPrompt: v })}
              />
              <textarea
                id="omni-system-prompt"
                value={draft.omniPrompt}
                onChange={(e) => patchDraft({ omniPrompt: e.target.value })}
                placeholder={DEFAULT_OMNI_PROMPT}
                rows={2}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm transition-colors focus:border-input-focus-border"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                这个模型自己就能听懂并整理，侧栏「AI 整理」里的供应商配置对它不生效。
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={closeEditor} disabled={saving}>取消</Button>
            <Button size="sm" onClick={() => void handleSaveDraft()} disabled={saving || !draftDirty}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="asr-service-heading" className="text-lg font-semibold">语音识别 (ASR)</h2>
              <Tooltip
                variant="light"
                content={'首选豆包 ASR：中文准确率高、速度快。\n多语种或想让识别与整理一步完成时，再看千问那几个。\n\n同一家可以存多份（比如两个账号），点一张即启用。'}
              >
                <Info aria-label="语音识别说明" className={helpIconClass} />
              </Tooltip>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              点一张即启用，它的供应商与密钥会一起生效。卡上的耗时是用内置测试音频真跑一次
              识别测出来的（会产生一次真实计费调用）。
            </p>
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleNew} disabled={busy}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            新建
          </Button>
        </div>

        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">正在读取已保存的服务…</p>
        ) : profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
            还没有配置语音识别服务。点右上角「新建」加一份，豆包 ASR 是最省事的起点。
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="asr-service-heading"
            className="grid gap-2.5 sm:grid-cols-3"
          >
            {profiles.map(renderCard)}
          </div>
        )}

        {notice && (
          <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
        )}
      </CardContent>

      {renderEditor()}

      {pendingDelete && (
        <Modal title="删除这份服务？" onClose={() => setPendingDeleteId('')} showCloseButton panelClassName="w-[420px]">
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted-foreground">
              将删除「{profileTitle(pendingDelete, profiles.filter((p) => p.provider === pendingDelete.provider).length)}」
              的配置与密钥。此操作不可撤销。
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingDeleteId('')}>取消</Button>
              <Button size="sm" onClick={() => void handleDelete(pendingDelete.id)}>删除</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  )
}
