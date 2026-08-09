// 通用设置页面 — 主题、快捷键、麦克风、悬浮窗、开机启动、音频保留、数据导出

import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { listMicrophones } from '@/services/audio'
import { refreshRecorderSettings } from '@/services/recorder'
import { getPresetShortcuts, getSetting, setSetting } from '@/services/store'
import { drawBars, resetWaveform } from '@/services/waveform'
import { Switch } from '@/components/ui/switch'
import AppSection from './AppSection'
import BackupSection from './BackupSection'
import MicrophoneSection from './MicrophoneSection'
import type { MicVolumeLevel } from './MicrophoneSection'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'

const HANDS_FREE_HELP = '可以设置哪些按键？\n支持单个常用按键（如右 Alt、Caps Lock、F1–F12）、“修饰键 + 主键”组合，也可以使用鼠标侧键或中键。\n\n绑定鼠标按键有什么影响？\n绑定侧键后，原来的前进 / 后退功能会被占用；绑定中键后，打开新标签页、自动滚动等功能可能无法使用。'

const PTT_HELP = '可以设置哪些按键？\n支持单个常用按键（如右 Shift、Caps Lock、F1–F12）、“修饰键 + 主键”组合、Ctrl + Win 这类纯修饰键组合，也可以使用鼠标侧键或中键。\n\n纯修饰键会影响系统操作吗？\n这些按键仍会传给 Windows，某些组合可能同时打开开始菜单等系统界面，建议设置后在常用应用中试用。\n\n绑定鼠标按键有什么影响？\n绑定侧键后，原来的前进 / 后退功能会被占用；绑定中键后，打开新标签页、自动滚动等功能可能无法使用。'

function ShortcutLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <Tooltip variant="light" content={help}>
        <Info
          aria-label={`${label}说明`}
          className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        />
      </Tooltip>
    </span>
  )
}

export default function GeneralSettingsPage() {
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [muteSystemAudio, setMuteSystemAudio] = useState(false)
  const [protectClipboard, setProtectClipboard] = useState(true)
  const [pttKey, setPttKey] = useState('ShiftRight')
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  // 读到已保存值之前，开关先隐藏、不放动画：避免「默认值 → 已保存值」闪一下
  const [ready, setReady] = useState(false)
  // animate 与 ready 分开：ready 决定何时显示，animate 决定何时允许过渡。
  // 若在揭开/赋值的同一帧就把 transition 加回来，按 CSS 规范浏览器会认为
  // 「有过渡且值变了」，于是把「默认值→已保存值」真的动画一遍（看起来就是闪一下）。
  // 所以揭开那一帧仍不带过渡，隔两帧待值稳定后才开过渡。
  const [animate, setAnimate] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    // 开关类设置：先把值全部取回，再在同一个同步块里一次性落值 + 置 ready，让 React
    // 合成一次渲染 —— 不存在「已显示但值还没到」的中间态（那正是开关闪一下的成因）。
    // 每项自带 catch 兜底：Promise.all 是 fail-fast，只要一项 reject 就会在其余项
    // 还没回来时提前放行 ready。也不用 rAF，避免 setReady 与赋值分到不同批次。
    void (async () => {
      const [launch, autoUpd, mute, clip, history, retention, readySound, audioDays, logDays] = await Promise.all([
        bridge.getAutoLaunch().catch(() => false),
        getSetting('autoCheckUpdate', true).catch(() => true),
        getSetting('muteSystemAudioWhileRecording', false).catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('audioRetentionEnabled', true).catch(() => true),
        getSetting('readySoundEnabled', true).catch(() => true),
        getSetting('audioRetentionDays', -1).catch(() => -1),
        getSetting('logRetentionDays', 30).catch(() => 30),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setAutoCheckUpdate(Boolean(autoUpd))
      setMuteSystemAudio(Boolean(mute))
      setProtectClipboard(Boolean(clip))
      setHistoryEnabled(Boolean(history))
      setAudioRetentionEnabled(Boolean(retention))
      setReadySoundEnabled(Boolean(readySound))
      const ad = Number(audioDays)
      if (ad === 7 || ad === 30 || ad === 90 || ad === -1) setAudioRetentionDays(ad)
      const ld = Number(logDays)
      if (ld === 7 || ld === 15 || ld === 30 || ld === 90) setLogRetentionDays(ld)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    getSetting('selectedMic', '').then(setSelectedMic)
    getSetting('shortcutPTT', 'ShiftRight').then((value) => setPttKey(value as string))
    getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
    listMicrophones().then(setMics).catch(() => { })
    return () => { cancelled = true }
  }, [])

  const toggleAutoLaunch = async () => { const next = !autoLaunch; setAutoLaunch(next); await bridge.setAutoLaunch(next) }
  const toggleAutoCheckUpdate = async () => { const next = !autoCheckUpdate; setAutoCheckUpdate(next); await setSetting('autoCheckUpdate', next) }
  const handleMicChange = async (deviceId: string) => { setSelectedMic(deviceId); await setSetting('selectedMic', deviceId); await refreshRecorderSettings() }
  const toggleMuteSystemAudio = async () => { const next = !muteSystemAudio; setMuteSystemAudio(next); await setSetting('muteSystemAudioWhileRecording', next); await refreshRecorderSettings() }
  const toggleProtectClipboard = async () => { const next = !protectClipboard; setProtectClipboard(next); await setSetting('protectClipboard', next); await refreshRecorderSettings() }
  const toggleHistoryEnabled = async () => { const next = !historyEnabled; setHistoryEnabled(next); await setSetting('historyEnabled', next) }
  const toggleAudioRetention = async () => { const next = !audioRetentionEnabled; setAudioRetentionEnabled(next); await setSetting('audioRetentionEnabled', next) }
  const toggleReadySound = async () => { const next = !readySoundEnabled; setReadySoundEnabled(next); await setSetting('readySoundEnabled', next); await refreshRecorderSettings() }
  const handleAudioRetentionDaysChange = async (value: number) => { setAudioRetentionDays(value); await setSetting('audioRetentionDays', value) }
  const handleLogRetentionDaysChange = async (value: number) => { setLogRetentionDays(value); await setSetting('logRetentionDays', value) }
  const handlePTTChange = async (value: string) => { setPttKey(value); await setSetting('shortcutPTT', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }
  const handleHandsFreeChange = async (value: string) => { setHandsFreeKey(value); await setSetting('shortcutHandsFree', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }

  // 应用内部快捷键互斥：免提和按住说话绑同一个键，两个功能会同时被触发；
  // 预设切换的组合键同理。提交前拦下来，而不是等用户按了才发现行为诡异。
  const validatePTT = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(value, handsFreeKey)) {
      return '与「免提模式」的快捷键相同，请更换一个按键'
    }
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).some(
      (shortcut) => pttShortcutConflictsWithAccelerator(value, shortcut),
    )) return '该按键已被 AI 整理的预设切换快捷键占用，请更换'
    return null
  }, [handsFreeKey])
  const validateHandsFree = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(pttKey, value)) {
      return '与「按住说话」的快捷键相同，请更换一个按键'
    }
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).includes(value)) return '该按键已被 AI 整理的预设切换快捷键占用，请更换'
    return null
  }, [pttKey])

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current; if (!canvas) return
    const context = canvas.getContext('2d'); if (!context) return
    const draw = () => { drawBars(context, analyser, canvas.width, canvas.height); animRef.current = requestAnimationFrame(draw) }
    draw()
  }, [])

  const testMic = async () => {
    if (testing) return; setTesting(true); setVolumeLevel('idle'); setMicError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMic ? { deviceId: { exact: selectedMic } } : true })
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7
      source.connect(analyser); resetWaveform(); drawWaveform(analyser)

      // 音量检测：每 500ms 采样一次，取 5 秒内的峰值 RMS 判断级别
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let peakRms = 0
      const volumeCheckId = setInterval(() => {
        analyser.getByteTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / dataArray.length)
        if (rms > peakRms) peakRms = rms
        // 实时更新级别
        if (peakRms < 0.002) setVolumeLevel('silent')
        else if (peakRms < 0.02) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      setTimeout(() => {
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        stream.getTracks().forEach((t) => t.stop()); context.close(); setTesting(false)
      }, 5000)
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'NotFoundError'
        ? '未检测到麦克风设备，请连接麦克风后重试'
        : err instanceof DOMException && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在系统设置中允许访问麦克风'
          : '麦克风访问失败，请检查设备连接'
      setMicError(msg)
      setTesting(false); setVolumeLevel('idle')
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">设置</h1>
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold">键盘快捷键</h2>
            {/* ⚠ 这是「按 Esc 能取消」在整个界面上的**唯一**出处 —— 悬浮窗上那行提示已经
                去掉了（见 overlay/Overlay.tsx 的 thinking 分支）。删掉这句，这个能力就没有
                任何地方告诉用户了。
                录音上限不在这里讲 —— 最后一分钟悬浮窗会显示剩余时间、到点自动结束，界面自己会说。
                「录音也不会保留」要写明：取消和「录了但没出字」在用户眼里很容易混。
                「录音或识别处理」是两个阶段，别连写 —— Esc 在两个阶段都能按。 */}
            <p className="mb-4 mt-1 text-xs text-muted-foreground">
              录音或识别处理期间按 Esc 可以取消本次识别，不会插入文字，录音也不会保留。
            </p>
            <div className="space-y-4">
              <ComboShortcutInput
                value={handsFreeKey}
                onChange={handleHandsFreeChange}
                validate={validateHandsFree}
                label={<ShortcutLabel label="免提模式" help={HANDS_FREE_HELP} />}
                description="适合持续说话：按一次开始录音，再按一次结束，全程无需按住快捷键"
              />
              <PTTShortcutInput
                value={pttKey}
                onChange={handlePTTChange}
                validate={validatePTT}
                label={<ShortcutLabel label="按住说话" help={PTT_HELP} />}
                description="适合随按随说：完整按下设定的按键或组合后开始录音，松开任意一个按键即结束"
              />
            </div>
          </CardContent>
        </Card>

        {/* 麦克风排在「偏好设置」前面：它是录音链路的入口，选错设备什么都录不到；
            而下面那三个开关（提示音、静音外放、剪贴板保护）都是可选的锦上添花。 */}
        <MicrophoneSection mics={mics} selectedMic={selectedMic} testing={testing} volumeLevel={volumeLevel}
          onCanvasRef={(node) => { canvasRef.current = node }} onMicChange={handleMicChange} onTestMic={testMic} errorMessage={micError} />

        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">偏好设置</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">录音就绪提示音</p>
                <p className="text-xs text-muted-foreground">按下热键后，录音准备好时播放一声短促提示音</p>
              </div>
              <Switch checked={readySoundEnabled} onChange={() => void toggleReadySound()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">录音时静音系统声音</p>
                <p className="text-xs text-muted-foreground">按住说话期间临时静音外放，避免被麦克风录入</p>
              </div>
              <Switch checked={muteSystemAudio} onChange={() => void toggleMuteSystemAudio()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">插入文本后保护剪贴板</p>
                <p className="text-xs text-muted-foreground">插入完成后自动还原为插入前的剪贴板内容，避免占用剪贴板</p>
              </div>
              <Switch checked={protectClipboard} onChange={() => void toggleProtectClipboard()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} autoCheckUpdate={autoCheckUpdate} onToggleAutoCheckUpdate={toggleAutoCheckUpdate} ready={ready} animate={animate} />

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">历史记录</h2>
                <p className="mt-1 text-sm text-muted-foreground">保存每次转写的文本与录音到本地历史，可随时回看、复制和重新识别。关闭后不再保存新的记录（适合与他人共用的电脑）；已有记录不会被删除，可在历史页手动清除。</p>
              </div>
              <Switch checked={historyEnabled} onChange={() => void toggleHistoryEnabled()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">音频保留</h2>
                <p className="mt-1 text-sm text-muted-foreground">录音结束后自动保存音频文件到本地，可在历史记录中回放和重新识别。</p>
              </div>
              <Switch checked={audioRetentionEnabled} onChange={() => void toggleAudioRetention()} noAnimation={!animate} hidden={!ready} />
            </div>
            {audioRetentionEnabled && (
              <div className="mt-4">
                <label className="text-sm text-muted-foreground">保留时长</label>
                <div className="mt-2 flex gap-2" style={ready ? undefined : { visibility: 'hidden' }}>
                  {([{ value: 7, label: '7 天' }, { value: 30, label: '1 个月' }, { value: 90, label: '3 个月' }, { value: -1, label: '永久' }] as const).map((opt) => (
                    <button key={opt.value} type="button" onClick={() => void handleAudioRetentionDaysChange(opt.value)}
                      className={`rounded-md border px-3 py-1.5 text-sm ${animate ? 'transition-colors' : ''} ${audioRetentionDays === opt.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-accent'}`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div>
              <h2 className="text-lg font-semibold">日志保留</h2>
              <p className="mt-1 text-sm text-muted-foreground">运行日志用于排查问题，超过保留时长的日志将自动清理。</p>
            </div>
            <div className="mt-4">
              <div className="flex gap-2" style={ready ? undefined : { visibility: 'hidden' }}>
                {([{ value: 7, label: '7 天' }, { value: 15, label: '15 天' }, { value: 30, label: '1 个月' }, { value: 90, label: '3 个月' }] as const).map((opt) => (
                  <button key={opt.value} type="button" onClick={() => void handleLogRetentionDaysChange(opt.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${animate ? 'transition-colors' : ''} ${logRetentionDays === opt.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-accent'}`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <BackupSection />
      </div>
    </div>
  )
}
