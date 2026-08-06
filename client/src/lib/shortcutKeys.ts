/**
 * 快捷键定义与 PTT 物理组合键工具。
 *
 * PTT 设置保存 DOM `KeyboardEvent.code`，旧单键保持 `ShiftRight` 等原格式，
 * 组合键按固定顺序保存为 `ControlLeft+MetaLeft`、`ControlLeft+KeyK`。
 *
 * ⚠️ Rust 端 `client/src-tauri/src/keyboard/mod.rs` 的按键表无法直接引用 TS；
 * 新增或修改 PTT code 时必须同步 Rust 映射。
 */

export interface SingleKeyDef {
  /** 存入设置、也等于 DOM KeyboardEvent.code */
  setting: string
  /** Windows 虚拟键码（供 webview 回退补发事件用） */
  vk: number
  /** 中文显示名 */
  label: string
}

export const SINGLE_KEYS: SingleKeyDef[] = [
  // 修饰键（左右分开）
  { setting: 'AltLeft', vk: 0xa4, label: '左 Alt' },
  { setting: 'AltRight', vk: 0xa5, label: '右 Alt' },
  { setting: 'ControlLeft', vk: 0xa2, label: '左 Ctrl' },
  { setting: 'ControlRight', vk: 0xa3, label: '右 Ctrl' },
  { setting: 'ShiftLeft', vk: 0xa0, label: '左 Shift' },
  { setting: 'ShiftRight', vk: 0xa1, label: '右 Shift' },
  // 常见低冲突键
  { setting: 'CapsLock', vk: 0x14, label: 'Caps Lock' },
  { setting: 'Space', vk: 0x20, label: '空格' },
  { setting: 'ContextMenu', vk: 0x5d, label: '菜单键' },
  { setting: 'Pause', vk: 0x13, label: 'Pause' },
  { setting: 'ScrollLock', vk: 0x91, label: 'ScrollLock' },
  { setting: 'Insert', vk: 0x2d, label: 'Insert' },
  // 鼠标侧键（原始 XBUTTON，由 Rust 低级鼠标钩子处理）
  { setting: 'XButton1', vk: 0x05, label: '鼠标侧键1（后退）' },
  { setting: 'XButton2', vk: 0x06, label: '鼠标侧键2（前进）' },
  // 鼠标中键（VK_MBUTTON，由 Rust 低级鼠标钩子处理）
  { setting: 'MButton', vk: 0x04, label: '鼠标中键' },
  // 浏览器后退/前进键（罗技等改键鼠标常把侧键映射成这个，由键盘钩子处理）
  { setting: 'BrowserBack', vk: 0xa6, label: '鼠标侧键（后退键）' },
  { setting: 'BrowserForward', vk: 0xa7, label: '鼠标侧键（前进键）' },
  // 功能键
  ...Array.from({ length: 12 }, (_, index) => ({
    setting: `F${index + 1}`,
    vk: 0x70 + index,
    label: `F${index + 1}`,
  })),
]

/** setting → 虚拟键码（旧单键与免提回退使用） */
export const SETTING_TO_VK: Record<string, number> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.vk]),
)

const SINGLE_KEY_DISPLAY: Record<string, string> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.label]),
)

/** PTT 修饰键固定排序；左右位置会保留。 */
export const PTT_MODIFIER_CODES = [
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
] as const

const PTT_MODIFIER_SET = new Set<string>(PTT_MODIFIER_CODES)
const PTT_MOUSE_CODES = new Set(['XButton1', 'XButton2', 'MButton'])

const PTT_EXTRA_KEY_DEFS: SingleKeyDef[] = [
  { setting: 'MetaLeft', vk: 0x5b, label: '左 Win' },
  { setting: 'MetaRight', vk: 0x5c, label: '右 Win' },
  ...Array.from({ length: 26 }, (_, index) => ({
    setting: `Key${String.fromCharCode(65 + index)}`,
    vk: 0x41 + index,
    label: String.fromCharCode(65 + index),
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    setting: `Digit${index}`,
    vk: 0x30 + index,
    label: String(index),
  })),
  { setting: 'Escape', vk: 0x1b, label: 'Esc' },
  { setting: 'Tab', vk: 0x09, label: 'Tab' },
  { setting: 'Enter', vk: 0x0d, label: 'Enter' },
  { setting: 'Backspace', vk: 0x08, label: 'Backspace' },
  { setting: 'Delete', vk: 0x2e, label: 'Delete' },
  { setting: 'ArrowUp', vk: 0x26, label: '↑' },
  { setting: 'ArrowDown', vk: 0x28, label: '↓' },
  { setting: 'ArrowLeft', vk: 0x25, label: '←' },
  { setting: 'ArrowRight', vk: 0x27, label: '→' },
  { setting: 'Home', vk: 0x24, label: 'Home' },
  { setting: 'End', vk: 0x23, label: 'End' },
  { setting: 'PageUp', vk: 0x21, label: 'Page Up' },
  { setting: 'PageDown', vk: 0x22, label: 'Page Down' },
]

/** PTT 成员 code → Windows 虚拟键码。 */
export const PTT_CODE_TO_VK: Record<string, number> = {
  ...SETTING_TO_VK,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.vk])),
}

const PTT_CODE_DISPLAY: Record<string, string> = {
  ...SINGLE_KEY_DISPLAY,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.label])),
}

/** 是否为受支持的旧单键设置。 */
export function isSingleKeySetting(setting: string): boolean {
  return setting in SETTING_TO_VK
}

/** 若 DOM code 对应一个受支持的旧单键，返回其 setting（= code）。 */
export function resolveSingleKeyShortcut(code: string): string | undefined {
  return isSingleKeySetting(code) ? code : undefined
}

/** setting → DOM code（恒等，未知返回空串）。 */
export function settingToCode(setting: string): string {
  return isSingleKeySetting(setting) ? setting : ''
}

/** 单键显示名（未知原样返回）。 */
export function getSingleKeyDisplay(value: string): string {
  return SINGLE_KEY_DISPLAY[value] || value
}

/** Tauri accelerator 的 Windows 显示名，用于逐个渲染键帽。 */
export function displayAccelerator(accelerator: string): string[] {
  const displayNames: Record<string, string> = {
    CommandOrControl: 'Ctrl',
    Control: 'Ctrl',
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Space: 'Space',
    Return: 'Enter',
  }
  return accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => displayNames[part] || part)
}

/** 单键或 accelerator 的统一 Windows 显示标签。 */
export function displayShortcut(shortcut: string): string[] {
  return isSingleKeySetting(shortcut)
    ? [getSingleKeyDisplay(shortcut)]
    : displayAccelerator(shortcut)
}

/** 拆分 PTT 设置；不在这里静默丢弃未知成员，交给校验器给出明确错误。 */
export function parsePTTShortcut(setting: string): string[] {
  if (!setting.trim()) return []
  return setting.split('+').map((part) => part.trim()).filter(Boolean)
}

/** 将 PTT 成员按 Ctrl、Win、Alt、Shift、普通键顺序规范化。 */
export function canonicalizePTTShortcut(settingOrCodes: string | Iterable<string>): string {
  const codes = typeof settingOrCodes === 'string'
    ? parsePTTShortcut(settingOrCodes)
    : Array.from(settingOrCodes)
  const uniqueCodes = [...new Set(codes)]
  const modifierOrder = new Map<string, number>(
    PTT_MODIFIER_CODES.map((code, index) => [code, index]),
  )
  return uniqueCodes.sort((left, right) => {
    const leftOrder = modifierOrder.get(left) ?? PTT_MODIFIER_CODES.length
    const rightOrder = modifierOrder.get(right) ?? PTT_MODIFIER_CODES.length
    return leftOrder - rightOrder || left.localeCompare(right)
  }).join('+')
}

/** PTT 设置的按键标签，用于逐个渲染键帽。 */
export function displayPTTShortcut(setting: string): string[] {
  return parsePTTShortcut(canonicalizePTTShortcut(setting)).map(
    (code) => PTT_CODE_DISPLAY[code] || code,
  )
}

export function isPTTModifierCode(code: string): boolean {
  return PTT_MODIFIER_SET.has(code)
}

export function pttShortcutHasModifier(setting: string): boolean {
  return parsePTTShortcut(setting).some(isPTTModifierCode)
}

/** 返回中文错误；null 表示可保存。 */
export function getPTTShortcutValidationError(setting: string): string | null {
  const rawCodes = setting.split('+').map((part) => part.trim())
  const codes = rawCodes.filter(Boolean)
  if (codes.length === 0) return '请至少按下一个按键'
  if (rawCodes.length !== codes.length || new Set(codes).size !== codes.length) {
    return '快捷键格式无效，请重新录制'
  }

  const unsupported = codes.find((code) => !(code in PTT_CODE_TO_VK))
  if (unsupported) return `暂不支持按键 ${unsupported}，请换一个组合`

  if (codes.length === 1) {
    const code = codes[0]
    if (code === 'MetaLeft' || code === 'MetaRight') {
      return 'Windows 键不能单独用于按住说话，请再搭配一个修饰键'
    }
    if (!isSingleKeySetting(code)) {
      return '字母、数字或导航键不能单独占用，请搭配 Ctrl、Win、Alt 或 Shift'
    }
    return null
  }

  if (codes.some((code) => PTT_MOUSE_CODES.has(code))) {
    return '鼠标按键暂不支持与键盘组合，请单独使用'
  }

  const modifiers = codes.filter(isPTTModifierCode)
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  const modifierFamilies = modifiers.map((code) => code.replace(/(?:Left|Right)$/, ''))
  if (new Set(modifierFamilies).size !== modifierFamilies.length) {
    return '同一类修饰键不能同时使用左右两侧，请保留其中一个'
  }
  if (mainKeys.length > 1) return '组合键最多只能包含一个非修饰键'
  if (mainKeys.length === 1 && modifiers.length === 0) {
    return '普通组合键至少需要一个 Ctrl、Win、Alt 或 Shift'
  }
  if (mainKeys.length === 0 && modifiers.length < 2) {
    return '纯修饰键组合至少需要两个按键'
  }

  const hasFamily = (prefix: string) => modifiers.some((code) => code.startsWith(prefix))
  const mainKey = mainKeys[0]
  if (hasFamily('Control') && hasFamily('Alt') && mainKey === 'Delete') {
    return 'Ctrl + Alt + Delete 是系统保留组合，请更换'
  }
  if (hasFamily('Meta') && (mainKey === 'KeyL' || mainKey === 'Tab')) {
    return '该 Windows 系统组合会锁屏或切换窗口，请更换'
  }
  if (hasFamily('Alt') && (mainKey === 'F4' || mainKey === 'Tab')) {
    return '该系统组合会关闭或切换窗口，请更换'
  }
  if (hasFamily('Control') && mainKey === 'Escape') {
    return 'Ctrl + Esc 会打开开始菜单，请更换'
  }

  return null
}

export function isValidPTTShortcut(setting: string): boolean {
  return getPTTShortcutValidationError(setting) === null
}

function pttMainCodeToAccelerator(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const aliases: Record<string, string> = {
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return aliases[code] || code
}

/**
 * 将可由 Tauri accelerator 表示的 PTT 组合转换为 accelerator。
 * 纯修饰组合以及同时包含 Ctrl 和 Win 的组合没有无损表示，返回 undefined。
 */
export function pttShortcutToAccelerator(setting: string): string | undefined {
  if (!isValidPTTShortcut(setting)) return undefined
  const codes = parsePTTShortcut(canonicalizePTTShortcut(setting))
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  if (mainKeys.length !== 1) return undefined

  const hasControl = codes.some((code) => code.startsWith('Control'))
  const hasMeta = codes.some((code) => code.startsWith('Meta'))
  if (hasControl && hasMeta) return undefined

  const parts: string[] = []
  // 现有免提录制将 Windows 的 Ctrl/Meta 都保存为 CommandOrControl。
  if (hasControl || hasMeta) parts.push('CommandOrControl')
  if (codes.some((code) => code.startsWith('Alt'))) parts.push('Alt')
  if (codes.some((code) => code.startsWith('Shift'))) parts.push('Shift')
  parts.push(pttMainCodeToAccelerator(mainKeys[0]))
  return parts.join('+')
}

function normalizeAccelerator(accelerator: string): string {
  const order: Record<string, number> = { CommandOrControl: 0, Alt: 1, Shift: 2 }
  const aliases: Record<string, string> = {
    Ctrl: 'CommandOrControl',
    Control: 'CommandOrControl',
    Command: 'CommandOrControl',
    Meta: 'CommandOrControl',
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return accelerator.split('+')
    .map((part) => aliases[part] || part)
    .sort((left, right) => (order[left] ?? 3) - (order[right] ?? 3) || left.localeCompare(right))
    .join('+')
}

/** 比较 PTT 物理组合与免提/预设 accelerator 是否会触发同一组合。 */
export function pttShortcutConflictsWithAccelerator(
  pttSetting: string,
  otherShortcut: string,
): boolean {
  if (!pttSetting || !otherShortcut) return false
  const pttCodes = parsePTTShortcut(canonicalizePTTShortcut(pttSetting))
  // 免提单键若同时是 PTT 组合成员，会被原生 hook 的“PTT 优先”规则完全遮蔽。
  if (isSingleKeySetting(otherShortcut) && pttCodes.includes(otherShortcut)) return true
  if (canonicalizePTTShortcut(pttSetting) === canonicalizePTTShortcut(otherShortcut)) return true
  const accelerator = pttShortcutToAccelerator(pttSetting)
  return accelerator !== undefined
    && normalizeAccelerator(accelerator) === normalizeAccelerator(otherShortcut)
}
