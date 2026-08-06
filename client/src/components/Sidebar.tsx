import { useEffect, useSyncExternalStore } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, Clock, BookOpen, Settings, Info, Wifi, WifiOff, Cpu, Cloud, AudioLines, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'

const dailyNavItems = [
  { to: '/', icon: Home, label: '首页' },
  { to: '/history', icon: Clock, label: '历史' },
]

const configNavItems = [
  { to: '/voice-engine', icon: AudioLines, label: '语音引擎' },
  { to: '/hotwords', icon: BookOpen, label: '热词' },
  { to: '/ai-instructions', icon: Wand2, label: 'AI 整理' },
  { to: '/ai-service', icon: Sparkles, label: 'AI 供应商' },
]

const footerNavItems = [
  { to: '/settings', icon: Settings, label: '设置' },
  { to: '/about', icon: Info, label: '关于' },
]

function NavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'bg-sidebar-item-active font-medium text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  )
}

function IconOnlyNavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-center rounded-lg p-2 transition-colors',
            isActive ? 'bg-sidebar-item-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
          )
        }
      >
        <Icon className="h-4 w-4" />
      </NavLink>
    </Tooltip>
  )
}

/**
 * 服务器模式的连接状态。
 *
 * 只有这一个模式配得上"状态指示"：它有一条真在跑的连接（30s 心跳），所以图标能诚实地
 * 报出此刻通不通——信号图标 + 颜色，断线换成带斜杠的那只。
 * 本地/云 API 没有这种持续探测，见 ModeIndicator 的注释。
 */
const statusConfig = {
  connected: { icon: Wifi, color: 'text-success', label: '后端已连接' },
  connecting: { icon: Wifi, color: 'text-warning animate-pulse', label: '正在连接…' },
  disconnected: { icon: WifiOff, color: 'text-muted-foreground', label: '后端未连接' },
  error: { icon: WifiOff, color: 'text-destructive', label: '连接失败' },
} as const

/**
 * 左下角的引擎指示：始终只占一个图标位，细节全在悬停提示里。
 *
 * 这里和「语音引擎」页那三张模式卡**不是同一件事**，所以图标也不必事事对齐：
 * 卡片上的图标是在给模式起名（Cpu / Cloud / Server，一个静态属性）；
 * 这里报的是"此刻怎么样"。于是只有服务器模式换成信号图标——它有一条真在跑的连接可报。
 *
 * 本地 / 云 API 一律是中性单色，**不给任何"好"的颜色**：我们唯一知道的事实是
 * "配置填完了没有"，而填完 ≠ 真的能用（模型能不能加载、密钥有没有被吊销，都没验过）。
 * 所以只有确定的坏消息（缺东西）才转 warning 色，其余保持沉默——
 * 曾经在这里点过绿灯，等于替一件没测过的事作保。
 */
function ModeIndicator() {
  const status = useConnectionStatus()
  const { mode, detail, ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  if (mode === 'server') {
    const { icon: StatusIcon, color, label } = statusConfig[status]
    return (
      <Tooltip content={`服务器模式 · ${label}`}>
        <div className="flex items-center justify-center rounded-lg p-2">
          <StatusIcon className={cn('h-4 w-4', color)} />
        </div>
      </Tooltip>
    )
  }

  const Icon = mode === 'local' ? Cpu : Cloud
  const title = mode === 'local' ? '本地模式' : '云 API 模式'
  const notReady = ready === false
  const tip = notReady
    ? `${title} · 待配置（${blockedReason || '配置未填完'}）`
    : detail ? `${title} · ${detail}` : title

  return (
    <Tooltip content={tip}>
      <div className="flex items-center justify-center rounded-lg p-2">
        <Icon className={cn('h-4 w-4', notReady ? 'text-warning' : 'text-sidebar-text')} />
      </div>
    </Tooltip>
  )
}

export default function Sidebar() {
  return (
    <nav className="flex w-48 flex-col border-r border-sidebar-border bg-sidebar py-4">
      <div className="flex-1 space-y-1 px-3">
        {dailyNavItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} />
        ))}

        <div className="px-1 py-3">
          <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        </div>
        {configNavItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} />
        ))}
      </div>

      <div className="space-y-3 px-3 pt-4">
        <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        <div className="flex items-center gap-1">
          {footerNavItems.map(({ to, icon, label }) => (
            <IconOnlyNavItem key={to} to={to} icon={icon} label={label} />
          ))}
          <ModeIndicator />
        </div>
      </div>
    </nav>
  )
}
