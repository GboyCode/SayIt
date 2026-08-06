// 服务器模式配置 — 服务地址 + 连接状态

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback, type FeedbackTone } from '@/components/ui/feedback'
import { Segmented } from '@/components/ui/segmented'
import {
  getBackendBaseUrl,
  getDefaultBackendBaseUrl,
  resetBackendBaseUrl,
  setBackendBaseUrl as persistBackendBaseUrl,
} from '@/services/runtimeConfig'
import { reconnectProvider } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { describeServerError } from '@/lib/errorMessages'

interface ServiceResult {
  tone: FeedbackTone
  message: string
  detail?: string
}

const LANGUAGES = [
  { value: 'auto', label: '自动' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
] as const

export default function ServerSection() {
  const [backendBaseUrl, setBackendBaseUrl] = useState('')
  /** 已保存的地址。输入框与它不一致就是「未保存」 */
  const [savedBaseUrl, setSavedBaseUrl] = useState('')
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('')
  const [result, setResult] = useState<ServiceResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [asrLanguage, setAsrLanguage] = useState('auto')

  useEffect(() => {
    const current = getBackendBaseUrl()
    setBackendBaseUrl(current)
    setSavedBaseUrl(current)
    setDefaultBaseUrl(getDefaultBackendBaseUrl())
    void getSetting('server.language', 'auto').then((v) => setAsrLanguage(String(v || 'auto')))
    // 切走路由时把"有未保存改动"复位，别把脏状态留给下一次进入
    return () => setEngineDraftDirty(false)
  }, [])

  const normalize = (v: string) => v.trim().replace(/\/+$/, '')

  const isDirty = normalize(backendBaseUrl) !== normalize(savedBaseUrl)
  const isCustom = normalize(savedBaseUrl) !== normalize(defaultBaseUrl)

  function handleUrlChange(value: string) {
    setBackendBaseUrl(value)
    setResult(null)
    setEngineDraftDirty(normalize(value) !== normalize(savedBaseUrl))
  }

  /** 探一次 /healthz。成功返回后端上报的 ASR/LLM 开关，失败抛出原始异常。 */
  async function probeHealth(url: string): Promise<{ asr?: boolean; llm?: boolean }> {
    const response = await fetch(`${url}/healthz`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as { asr?: boolean; llm?: boolean }
  }

  /** 把 /healthz 的 asr/llm 布尔量翻译成人话。原来直接显示「ASR=on，LLM=off」，
   *  那是把后端的 JSON 字段原样贴给用户。 */
  function describeHealth(payload: { asr?: boolean; llm?: boolean }, prefix: string): ServiceResult {
    if (payload.asr === false) {
      return {
        tone: 'warning',
        message: `${prefix}，能连上，但这台服务器的语音识别没有就绪，现在还不能用来口述。检查服务端的 ASR 模型是否加载成功。`,
      }
    }
    if (payload.llm === false) {
      return {
        tone: 'success',
        message: `${prefix}，连接成功。这台服务器只提供语音识别，没有开启 AI 整理——口述出来的是原始转写，不会润色。`,
      }
    }
    return { tone: 'success', message: `${prefix}，连接成功，语音识别与 AI 整理都可用。` }
  }

  /**
   * 保存并测试。
   *
   * 这里原来是两个同权重的按钮：「测试连接」只测不存（用输入框里的值），「保存」存了再测。
   * 用户点前者看到「连接成功」，合理地以为配置生效了——它没有。两个动作合并成一个之后，
   * 界面上就不再存在"测试通过但没保存"这种状态。
   */
  async function handleSaveAndTest() {
    if (busy) return
    const normalized = normalize(backendBaseUrl)
    if (!normalized) {
      setResult({ tone: 'warning', message: '服务地址不能为空。' })
      return
    }
    try {
      new URL(normalized)
    } catch {
      setResult({
        tone: 'warning',
        message: '这不是一个合法的网址。要带上 https:// 或 http:// 前缀，例如 https://sayitapp.site。',
      })
      return
    }

    setBusy(true)
    setResult(null)
    try {
      const next = await persistBackendBaseUrl(normalized)
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      // 地址已变更：无论下方健康检查成功与否，都按新地址强制重连，
      // 让左下角连接状态反映新配置（改成错误地址后应显示未连接，而非仍旧"已连接"）
      reconnectProvider()
    } catch (error) {
      setResult({ tone: 'error', message: '地址没能保存。', detail: String(error) })
      setBusy(false)
      return
    }

    try {
      const payload = await probeHealth(normalized)
      setResult(describeHealth(payload, '已保存'))
    } catch (error) {
      const friendly = describeServerError(error, normalize(normalized) !== normalize(defaultBaseUrl))
      setResult({
        tone: 'error',
        message: `地址已保存，但连不上：${friendly.message}`,
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  /** 恢复到内置默认地址并立刻重连，省得用户自己回忆默认值是什么 */
  async function handleResetDefault() {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const next = await resetBackendBaseUrl()
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      reconnectProvider()
      const payload = await probeHealth(next)
      setResult(describeHealth(payload, `已恢复默认地址 ${next}`))
    } catch (error) {
      const friendly = describeServerError(error, false)
      setResult({
        tone: 'error',
        message: `已恢复默认地址，但连不上：${friendly.message}`,
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold">服务地址</h2>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            输入你部署的 SayIt 服务器地址，保存后客户端会自动连接。
            <Tooltip
              variant="light"
              content={'默认地址 sayitapp.site 是作者提供的免费体验服务器，已内置语音识别与 AI 功能，方便快速试用。\n由于服务器运行存在成本，服务不保证长期稳定可用。\n如需稳定使用，建议使用本地识别、接入豆包 API，或自行部署后端服务。'}
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground transition-colors hover:text-foreground" />
            </Tooltip>
          </p>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2">
              <label htmlFor="server-base-url" className="text-sm text-muted-foreground">
                服务地址
              </label>
              {/* 输入框内容只活在 local state 里，切页就没了。原来这件事完全无提示，
                  用户会以为改完就生效了。 */}
              {isDirty && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-strong">
                  未保存
                </span>
              )}
            </div>
            {/* flex-wrap：800×600 最小窗口下侧栏占掉 192px，输入框 + 按钮挤在一行会溢出 */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="server-base-url"
                type="url"
                inputMode="url"
                value={backendBaseUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveAndTest() }}
                placeholder={defaultBaseUrl || 'https://sayitapp.site'}
                className="h-9 min-w-[16rem] flex-1 rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border"
              />
              <Button size="sm" className="h-9 shrink-0" onClick={() => void handleSaveAndTest()} disabled={busy}>
                {busy ? '保存并测试中…' : '保存并测试'}
              </Button>
              {isCustom && (
                <Button size="sm" variant="ghost" className="h-9 shrink-0" onClick={() => void handleResetDefault()} disabled={busy}>
                  恢复默认
                </Button>
              )}
            </div>
          </div>

          {/* 这里原来在失败提示里再挂一个「恢复默认地址（https://…）」按钮：
              一是把整条 URL 塞进按钮文字，全应用没有第二处这么写；
              二是它和输入框旁边那个「恢复默认」完全同义——而后者在地址被改过时一直都在，
              正好覆盖会出现这条失败提示的全部情况。留一个就够。 */}
          {result && (
            <Feedback
              className="mt-3"
              tone={result.tone}
              message={result.message}
              detail={result.detail}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 id="server-language-heading" className="mb-3 text-lg font-semibold">识别语言</h2>
          <Segmented
            labelledBy="server-language-heading"
            value={asrLanguage}
            options={LANGUAGES}
            onChange={(value) => { setAsrLanguage(value); void setSetting('server.language', value) }}
          />
          {/* 说清作用范围：这个值只跟着服务器模式走（随每次识别发给服务端，
              由 asr.py 的 _resolve_language 映射成 Chinese/English，auto = 让模型自检）。
              本地模式有它自己的一份，云 API 模式没有这个选项。 */}
          <p className="mt-2 text-xs text-muted-foreground">
            只影响服务器模式的识别。大部分场景选「自动」；固定只说一种语言时选对应项更稳——短句上自动检测偶尔会认错语种。
          </p>
        </CardContent>
      </Card>
    </>
  )
}
