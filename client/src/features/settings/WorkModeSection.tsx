// 工作模式切换卡片

import { useEffect, useSyncExternalStore } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
// 这三个图标是在给模式**起名**，不是报状态，所以选的是"这个模式是什么"的最短表达：
// 本地在本机算 → Cpu，云 API 用你自己的云厂商 → Cloud，服务器模式连的是一台服务器 → Server。
// 比原来的 Monitor（显示器）/ Globe（地球）/ HardDrive（硬盘）都更贴。
//
// 左下角的引擎指示里，服务器模式用的是信号图标而不是 Server——那里报的是"此刻通不通"，
// 有一条真在跑的连接可报；这张卡不做这种断言（连接状态由卡组右上角那枚徽标负责）。
// 两处对本地 / 云 API 用同一个图标，对服务器模式刻意不同，因为它们说的不是同一件事。
import { Cpu, Cloud, Server, Check, type LucideIcon } from 'lucide-react'
import type { WorkMode } from '@/services/transcription'

const modes: Array<{ value: WorkMode; label: string; desc: string; privacy: string; icon: LucideIcon }> = [
  {
    value: 'local', label: '本地模式',
    desc: '语音识别完全在本机运行，无需联网',
    privacy: '不开启 AI 整理时数据全程留在本地；开启后文本会发送给 AI 整理。',
    icon: Cpu,
  },
  {
    value: 'cloud_api', label: '云 API 模式',
    desc: '使用你自己的云服务商密钥',
    privacy: '音频和文本会发送到你配置的云服务商处理。',
    icon: Cloud,
  },
  {
    value: 'server', label: '服务器模式',
    desc: '连接自部署的远程服务器',
    privacy: '音频发送到服务器处理后不保留，仅本地保存结果。',
    icon: Server,
  },
]

const statusConfig = {
  connected: { dot: 'bg-success', text: '已连接', bg: 'bg-success/10 text-success-strong' },
  connecting: { dot: 'bg-warning animate-pulse', text: '连接中', bg: 'bg-warning/10 text-warning-strong' },
  disconnected: { dot: 'bg-muted-foreground', text: '未连接', bg: 'bg-muted text-muted-foreground' },
  error: { dot: 'bg-destructive', text: '连接失败', bg: 'bg-destructive/10 text-destructive-strong' },
} as const

interface Props {
  value: WorkMode
  onChange: (mode: WorkMode) => void
}

export default function WorkModeSection({ value, onChange }: Props) {
  const wsStatus = useConnectionStatus()
  const { ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  // 徽标反映真实就绪状态，所以本组件也要在挂载时拉一次（页面可能是直接深链进来的）
  useEffect(() => { void refreshModeStatus() }, [])

  /**
   * 状态徽标。
   *
   * 这里曾经是三个三元：服务器模式看真实连接状态，本地/云 API **一律**绿点 +「就绪」。
   * 结果是模型没下载、密钥没填也显示绿灯，而卡片正下方同时写着「模型尚未下载」——
   * 同屏自相矛盾。现在本地/云 API 的就绪判断来自 modeStatus（见该 store 的注释），
   * 未就绪时显示「待配置」并可点击滚到对应的配置卡。
   */
  const badge = value === 'server'
    ? { ...statusConfig[wsStatus], hint: '' }
    : ready === false
      ? {
        dot: 'bg-warning',
        text: '待配置',
        bg: 'bg-warning/10 text-warning-strong',
        hint: blockedReason ? `${blockedReason}，按下快捷键不会有反应` : '配置还没填完',
      }
      : ready === true
        ? { dot: 'bg-success', text: '就绪', bg: 'bg-success/10 text-success-strong', hint: '' }
        : { dot: 'bg-muted-foreground', text: '检查中', bg: 'bg-muted text-muted-foreground', hint: '' }

  const scrollToConfig = () => {
    document.getElementById('engine-config')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const badgeBody = (
    <>
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${badge.dot}`} aria-hidden />
      {badge.text}
    </>
  )
  const badgeClass = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${badge.bg}`

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="work-mode-heading" className="text-lg font-semibold">工作模式</h2>

          {badge.hint ? (
            <Tooltip variant="light" content={`${badge.hint}。点击跳到需要填的地方。`}>
              <button
                type="button"
                onClick={scrollToConfig}
                className={`${badgeClass} transition-colors hover:bg-warning/20`}
              >
                {badgeBody}
              </button>
            </Tooltip>
          ) : (
            <span className={badgeClass} role="status">{badgeBody}</span>
          )}
        </div>

        <div
          role="radiogroup"
          aria-labelledby="work-mode-heading"
          className="grid gap-3 sm:grid-cols-3"
        >
          {modes.map((m) => {
            const isActive = value === m.value
            const Icon = m.icon
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => onChange(m.value)}
                className={`relative rounded-lg border p-4 text-left transition-colors ${isActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent'
                  }`}
              >
                <Icon
                  className={`absolute right-3 top-3 h-5 w-5 transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-hidden
                />
                {/* 选中态原来只有颜色（1px 边框 + 图标变色 + 5% 的淡底）。加一个对勾，
                    让"当前是哪个"不依赖颜色感知 */}
                <div className="flex items-center gap-1 pr-7 text-sm font-medium">
                  {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
                  {m.label}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{m.desc}</div>
                <div className="mt-2 border-t border-border/50 pt-2 text-xs leading-relaxed text-muted-foreground">
                  {m.privacy}
                </div>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
