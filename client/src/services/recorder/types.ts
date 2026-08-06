export type RecorderState = 'idle' | 'recording' | 'processing'

export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

export type OverlayWidthPreset = 'short' | 'medium' | 'long'

export interface OverlayWidthConfig {
  barCount: number
  windowWidth: number
}

export const OVERLAY_WIDTH_PRESETS: Record<OverlayWidthPreset, OverlayWidthConfig> = {
  short:  { barCount: 12, windowWidth: 200 },
  medium: { barCount: 18, windowWidth: 280 },
  long:   { barCount: 24, windowWidth: 360 },
}

export interface OverlayCommonPayload {
  theme: OverlayWaveTheme
  showDuration: boolean
  baseWidth?: number
  barCount?: number
}

export interface PTTEventPayload {
  source?: string
  keycode?: number
  rawcode?: number
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  reason?: string
  pttSetting?: string
  timestamp?: number
}

/**
 * 单次录音上限（秒）。到点会自动结束本次录音并进入识别。
 *
 * ⚠️ 必须与 Rust 侧 `keyboard/mod.rs` 的 HARD_RELEASE_AFTER_SECS 保持一致
 * （按住说话的硬释放在 Rust 看门狗里；免提的自动停止在 RecorderOrchestrator）。
 */
export const MAX_RECORDING_SEC = 300

/** 距上限还剩多少秒时，计时区改为显示倒计时（提醒即将到点） */
export const RECORDING_COUNTDOWN_SEC = 60

/** 上限的中文说明（如「5 分钟」/「45 秒」）。界面文案一律用它，避免改了上限忘了改文案。 */
export function formatRecordingLimit(): string {
  if (MAX_RECORDING_SEC < 60) return `${MAX_RECORDING_SEC} 秒`
  const minutes = Math.floor(MAX_RECORDING_SEC / 60)
  const seconds = MAX_RECORDING_SEC % 60
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
}

/**
 * 悬浮窗计时区要显示的内容。
 *
 * 最后一分钟把"已录多久"换成"还剩多久"：到点会自动结束，此时用户更需要知道剩余时间。
 * 文案保持紧凑（`剩余 47s`）—— 胶囊宽度按波形条数固定，太长会被裁掉。
 */
export function formatRecordingTimer(elapsedSec: number): {
  text: string
  countdown: boolean
  remainingSec: number
} {
  const elapsed = Math.max(0, Math.floor(elapsedSec || 0))
  const remainingSec = Math.max(0, MAX_RECORDING_SEC - elapsed)
  const countdown = remainingSec <= RECORDING_COUNTDOWN_SEC
  return {
    text: countdown ? `剩余 ${remainingSec}s` : `${elapsed}s`,
    countdown,
    remainingSec,
  }
}
