// ASR 测试卡片 — 用内置测试音频测试当前模式的识别效果

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Pause } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import { getSetting } from '@/services/store'
import { getEngineDraftDirty, subscribeEngineDraft } from '@/stores/engineDraft'
import { isQwenOmniProvider, resolveAsrDisplayModel, resolveQwenOmniModel } from '@/lib/asrModels'
import { describeProviderError, describeServerError } from '@/lib/errorMessages'
import type { WorkMode } from '@/services/transcription'

interface TestResult {
  text: string
  asrMs: number
  mode: string
  model: string
  audioDurationSec: number
}

interface TestError {
  message: string
  detail?: string
}

export default function AsrTestSection({ workMode }: { workMode: WorkMode }) {
  const [testing, setTesting] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  // 失败原来是被写进 result.text 的，于是用与成功完全相同的面板渲染出来，
  // 外面还配着「ASR 0ms」的徽标——失败长得像"成功识别出了『测试失败:』这几个字"。
  const [error, setError] = useState<TestError | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // 上方配置有未保存改动时，这里读到的还是旧值，测出来的结果没有意义
  const draftDirty = useSyncExternalStore(subscribeEngineDraft, getEngineDraftDirty)

  // 换了工作模式，旧结果就不再说明任何事情，直接作废
  useEffect(() => {
    setResult(null)
    setError(null)
  }, [workMode])

  async function handlePlay() {
    if (playing && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setPlaying(false)
      return
    }
    try {
      const b64 = await invoke<string>('get_test_audio_b64')
      const audio = new Audio(`data:audio/wav;base64,${b64}`)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      setPlaying(true)
      await audio.play()
    } catch {
      setPlaying(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setResult(null)
    setError(null)

    try {
      // 获取测试音频并计算时长
      const wavB64 = await invoke<string>('get_test_audio_b64')
      const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
      const pcmBytes = wavBytes.slice(44)
      const audioDurationSec = pcmBytes.length / 2 / 16000

      if (workMode === 'local') {
        const modelId = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
        const language = await getSetting('localAsr.language', 'auto') as string
        const r = await invoke<{ text: string; elapsed_ms: number; model_id: string }>('run_asr_benchmark', {
          modelId, language,
        })
        setResult({ text: r.text, asrMs: r.elapsed_ms, mode: '本地', model: r.model_id, audioDurationSec })
      } else if (workMode === 'cloud_api') {
        let pcmB64 = ''
        const chunk = 8192
        for (let i = 0; i < pcmBytes.length; i += chunk) {
          const slice = pcmBytes.subarray(i, Math.min(i + chunk, pcmBytes.length))
          pcmB64 += String.fromCharCode(...slice)
        }
        pcmB64 = btoa(pcmB64)

        const asrProvider = await getSetting('cloudAsr.provider', 'doubao_v2') as string
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string

        // 模型解析一律走 @/lib/asrModels。这里原来自己抄了一份映射表，还留着几个
        // 已经不在 ASR_PROVIDERS 里的旧 key——测试可能用与实际配置不同的模型。
        const isOmni = isQwenOmniProvider(asrProvider)
        const qwenOmniModel = resolveQwenOmniModel(asrProvider)
        let omniExtra: Record<string, unknown> | undefined
        if (isOmni) {
          const savedPrompt = await getSetting('cloudAsr.omniSystemPrompt', '') as string
          omniExtra = { model: qwenOmniModel, instructions: savedPrompt || undefined }
        }

        const start = performance.now()
        const r = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
          request: {
            audio_b64: pcmB64,
            sample_rate: 16000,
            asr_config: {
              provider: isOmni ? 'qwen_omni' : asrProvider,
              api_key: asrApiKey,
              app_id: asrAppId,
              ...(omniExtra && { extra: omniExtra }),
            },
          },
        })
        const totalMs = Math.round(performance.now() - start)
        setResult({
          text: r.text,
          asrMs: totalMs,
          mode: '云 API',
          model: isOmni ? (qwenOmniModel || asrProvider) : resolveAsrDisplayModel(asrProvider),
          audioDurationSec,
        })
      } else {
        // 服务器模式
        const { getWSUrl } = await import('@/services/runtimeConfig')
        const wsUrl = getWSUrl()

        const r = await new Promise<{ text: string; asrMs: number }>((resolve, reject) => {
          const timeout = setTimeout(() => { try { sock.close() } catch { } reject(new Error('超时')) }, 30000)
          const sock = new WebSocket(wsUrl)
          sock.binaryType = 'arraybuffer'
          sock.onopen = () => {
            sock.send(JSON.stringify({ cmd: 'start', disable_ai: true }))
            // 分块发送 PCM（每块 3200 字节 = 100ms @16kHz 16bit mono）
            const chunkSize = 3200
            for (let i = 0; i < pcmBytes.length; i += chunkSize) {
              sock.send(pcmBytes.slice(i, i + chunkSize).buffer)
            }
            sock.send(JSON.stringify({ cmd: 'stop' }))
          }
          sock.onmessage = (e) => {
            if (typeof e.data !== 'string') return
            try {
              const msg = JSON.parse(e.data)
              if (msg.type === 'final') {
                clearTimeout(timeout)
                resolve({ text: msg.asr_text || '', asrMs: msg.asr_ms || 0 })
                sock.close()
              } else if (msg.type === 'error') {
                clearTimeout(timeout)
                reject(new Error(msg.message || '服务器错误'))
                sock.close()
              }
            } catch { }
          }
          sock.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket 连接失败')) }
        })

        setResult({ text: r.text, asrMs: r.asrMs, mode: '服务器', model: '服务端 ASR', audioDurationSec })
      }
    } catch (err) {
      const friendly = workMode === 'server'
        ? describeServerError(err, true)
        : describeProviderError(err)
      setError({ message: friendly.message, detail: friendly.detail })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        {/* flex-wrap：最小窗口下标题 + 两个按钮挤一行会溢出 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">识别测试</h2>
            {/* 这张卡只测 ASR。服务器模式下请求里写着 disable_ai: true，本地和云 API 也
                不经过 AI 整理——原来界面上还渲染一个恒为 0 的「LLM 0ms」，会让人以为
                AI 整理坏了。现在把范围说清，并不再展示那个假字段。 */}
            <p className="mt-1 text-xs text-muted-foreground">
              用内置的一段中文音频测当前模式的识别速度和准确率。只测语音识别，不含 AI 整理。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => void handlePlay()}>
              {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {playing ? '暂停' : '播放'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => void handleTest()}
              disabled={testing || draftDirty}
            >
              {testing ? '识别中…' : '开始测试'}
            </Button>
          </div>
        </div>

        {/* 测试读的是已保存的配置。粘完密钥直接点测试必然失败，用户会误判成"密钥是坏的"。 */}
        {draftDirty && (
          <Feedback
            className="mt-4"
            tone="warning"
            message="上方还有没保存的配置。测试用的是已保存的值，先保存再测。"
          />
        )}

        {error && (
          <Feedback
            className="mt-4"
            tone="error"
            message={`识别测试没通过：${error.message}`}
            detail={error.detail}
            actions={[{ label: '重试', onClick: () => void handleTest(), disabled: testing }]}
          />
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="rounded bg-primary/10 px-2 py-0.5 text-primary">{result.mode}</span>
              <span className="rounded bg-muted px-2 py-0.5">{result.model}</span>
              <span>音频 {result.audioDurationSec.toFixed(1)}s</span>
              <span>识别耗时 {result.asrMs}ms</span>
            </div>
            <p className="mt-2 text-sm text-foreground">{result.text || '（没有识别出内容）'}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
