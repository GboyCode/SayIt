// 侧边栏左下角"当前语音引擎"指示的全局状态（useSyncExternalStore 模式，同 connectionStatus）。
//
// 为什么单独一个 store：模式/模型信息分散在三个设置里（workMode、localAsr.modelId、
// cloudAsr.provider），侧边栏常驻但设置页在别的路由改这些值，需要一个可订阅的快照。
// 谁改了相关设置谁调 refreshModeStatus()——目前是 VoiceEnginePage（切模式）、
// LocalModeSection（换本地模型）、CloudAPISection（换云供应商）三处 + 侧边栏挂载时。
//
// 有意从 store 直接读 workMode 而不是 getWorkMode()：后者要等 initProviderFromStore
// 跑完才准，而侧边栏可能先挂载；读存储永远是真值，也避免了循环依赖。

import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../services/store'
import { loadAsrProfiles } from '../features/settings/asrProfileStore'
import {
  describeAsrMissing,
  findAsrProvider,
  resolveActiveAsrProfile,
} from '../features/settings/asrProviderCatalog'

export type ModeStatusMode = 'server' | 'cloud_api' | 'local'

export interface ModeStatus {
  mode: ModeStatusMode
  /** 简短的引擎说明：本地 = 模型名（"SenseVoice Small"），云 API = 供应商简称（"豆包"） */
  detail: string
  /**
   * 这个模式是不是**真的**能用了。
   * 服务器模式为 null——它的可用性由 WebSocket 连接状态决定，交给 useConnectionStatus。
   *
   * 为什么加这个：状态徽标原来对本地/云 API 一律硬编码绿点 +「就绪」，模型没下载、
   * key 没填也照样绿灯。用户据此关掉窗口、按下热键、什么都没发生，且不知道去哪儿查。
   */
  ready: boolean | null
  /** 未就绪时缺的是什么（一句话，直接可展示） */
  blockedReason: string
}

type Listener = () => void

let currentStatus: ModeStatus = { mode: 'server', detail: '', ready: null, blockedReason: '' }
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

export function getModeStatus(): ModeStatus {
  return currentStatus
}

export function subscribeModeStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 云 API 供应商 key → 侧边栏简称。完整模型名在 Tooltip 里（resolveAsrDisplayModel）。 */
const CLOUD_PROVIDER_SHORT: Record<string, string> = {
  doubao_v2: '豆包',
  qwen: '千问',
  qwen_realtime: '千问实时',
  qwen_omni_35_plus: '千问 Omni',
  qwen_omni_35_flash: '千问 Omni',
  qwen_omni_flash: '千问 Omni',
  qwen_omni_turbo: '千问 Omni',
  mimo: 'MiMo',
}

/** 重新从设置里读一遍模式/模型并广播。相关设置变更后调用。 */
export async function refreshModeStatus(): Promise<void> {
  const stored = await getSetting('workMode', 'server') as string
  const mode: ModeStatusMode =
    stored === 'local' || stored === 'cloud_api' ? stored : 'server'

  let detail = ''
  let ready: boolean | null = null
  let blockedReason = ''

  if (mode === 'local') {
    const modelId = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
    try {
      const models = await invoke<{ id: string; name: string }[]>('list_available_models')
      detail = models.find((m) => m.id === modelId)?.name ?? modelId
    } catch {
      detail = modelId
    }
    // 本地模式就绪 = 选中的模型已完整下载到本地
    try {
      const downloaded = await invoke<{ id: string; complete: boolean }[]>('list_downloaded_models')
      ready = downloaded.some((m) => m.id === modelId && m.complete)
      if (!ready) blockedReason = '选中的模型还没下载'
    } catch {
      // 读不到本地模型列表时不敢断言就绪，按未就绪处理并说明原因
      ready = false
      blockedReason = '读不到本地模型列表'
    }
  } else if (mode === 'cloud_api') {
    // 就绪与否看**启用中那份服务档案**，而不是各平台的原始键：同一家可以存多份，
    // 只有被启用的那份才决定录音时用什么。设置页与这里都从同一个列表读，不会打架。
    const state = await loadAsrProfiles()
    const active = resolveActiveAsrProfile(state.profiles, state.activeId)
    if (!active) {
      detail = '未配置'
      ready = false
      blockedReason = '还没配置语音识别服务'
    } else {
      detail = CLOUD_PROVIDER_SHORT[active.provider] ?? active.provider
      const missing = describeAsrMissing(active)
      // 流式识别缺业务空间 ID 时也算没配好：它会直接连不上地域专属端点
      const needsWorkspace = findAsrProvider(active.provider)?.needsWorkspaceId === true
        && active.workspaceId.trim() === ''
      ready = missing === '' && !needsWorkspace
      blockedReason = missing || (needsWorkspace ? '还没填业务空间 ID' : '')
    }
  }

  if (
    currentStatus.mode === mode
    && currentStatus.detail === detail
    && currentStatus.ready === ready
    && currentStatus.blockedReason === blockedReason
  ) return
  currentStatus = { mode, detail, ready, blockedReason }
  emitChange()
}
