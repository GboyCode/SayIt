/**
 * RecorderOrchestrator 纯辅助函数
 * 不依赖 this 状态，可独立测试
 */

import type { ActiveAppContext } from '@/types/appContext'

/** 简化 AppContext 用于日志输出 */
export function summarizeAppContext(context: ActiveAppContext | null) {
  if (!context) return null
  return {
    processName: context.processName,
    exePath: context.exePath,
    windowTitle: context.windowTitle,
    windowClass: context.windowClass,
    focusClass: context.focusClass,
    controlType: context.controlType,
    focusedName: context.focusedName,
  }
}

/** 从 AppContext 中提取用于统计的 appId */
export function buildStatsAppId(
  appContext: ActiveAppContext | null,
  promptAppId?: string,
): string {
  const processName = String(appContext?.processName || '').trim()
  if (processName) return processName

  const exePath = String(appContext?.exePath || '').trim()
  if (exePath) {
    const segments = exePath.split(/[\\/]/).filter(Boolean)
    const lastSegment = segments[segments.length - 1]
    if (lastSegment) return lastSegment
  }

  return String(promptAppId || '').trim() || 'unknown'
}

/** 录音时的麦克风音量分级 */
export type MicLevel = 'muted' | 'low' | 'voiced'

/** 峰值幅度（0..1）低于此值视为「几乎无信号」——静音流是一串 0，峰值≈0；
 *  真实环境即使很安静也会有零星峰值超过它，用峰值比只看 RMS 更能准确区分「被静音/选错设备」。 */
export const MIC_MUTE_PEAK_THRESHOLD = 0.002
/** 有信号（峰值达标）但 RMS（0..1）低于此值视为「声音偏低」（离得远 / 说太小声）。 */
export const MIC_LOW_RMS_THRESHOLD = 0.008

/**
 * 按本帧的 RMS 与峰值幅度分级：
 *  - muted ：峰值≈0，几乎没有任何信号（极可能麦克风被静音 / 选错设备 / 未授权）
 *  - low   ：有波动但整体偏低（距离远 / 声音小）
 *  - voiced：正常音量
 * 两个入参都应为归一化到 0..1 的值（原始 int16 除以 32768）。
 */
export function classifyMicLevel(rms: number, framePeak: number): MicLevel {
  if (framePeak < MIC_MUTE_PEAK_THRESHOLD) return 'muted'
  if (rms < MIC_LOW_RMS_THRESHOLD) return 'low'
  return 'voiced'
}

/** 判断 PTT 设置中是否包含修饰键（旧单键与物理组合格式都支持） */
export function isModifierPTTSetting(pttSetting?: string): boolean {
  if (!pttSetting) return false
  return pttSetting.split('+').some((code) => (
    code.startsWith('Alt')
    || code.startsWith('Control')
    || code.startsWith('Shift')
    || code.startsWith('Meta')
  ))
}

const PROCESSING_TIMEOUT_BASE_MS = 15_000
const PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS = 500
const PROCESSING_TIMEOUT_MAX_EXTRA_MS = 30_000

/** 根据音频时长和工作模式计算处理超时时间 */
export function computeProcessingTimeoutMs(
  audioDurationSec: number,
  providerMode: string,
): number {
  const safeAudioSec = Number.isFinite(audioDurationSec) ? Math.max(0, audioDurationSec) : 0
  const extraMs = Math.min(
    PROCESSING_TIMEOUT_MAX_EXTRA_MS,
    Math.ceil(safeAudioSec * PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS),
  )
  let timeout = PROCESSING_TIMEOUT_BASE_MS + extraMs

  if (providerMode !== 'server') {
    timeout = Math.max(timeout, 30000)
  }
  if (providerMode === 'cloud_api') {
    const cloudTimeout = 30000 + Math.ceil(safeAudioSec * 500)
    timeout = Math.min(Math.max(timeout, cloudTimeout), 90000)
  }
  return timeout
}
