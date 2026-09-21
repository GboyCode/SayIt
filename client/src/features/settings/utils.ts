export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

// 快捷键映射已收敛到 @/lib/shortcutKeys（单一数据源），这里透传导出以保持既有引用不变。
export {
  displayAccelerator,
  eventToAccelerator,
  getSingleKeyDisplay,
  keyEventToShortcutCandidate,
  resolveSingleKeyShortcut,
} from '@/lib/shortcutKeys'

export function cleanMicLabel(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
}
