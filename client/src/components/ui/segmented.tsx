// 单选胶囊组（识别语言 / 下载源 / 计算后端 / 模型驻留 …）
//
// 为什么抽出来：这个形态在设置页里被手抄了 5 遍，每一遍都是裸 <button>，选中态**只有颜色**
// （border-primary bg-primary），既没有 role="radio" 也没有 aria-checked。键盘用户 Tab 过
// 「自动 / 中文 / 英文」时拿不到"哪个是当前值"这条信息。收成一个组件后，语义只需修一次。
//
// 视觉与原来逐字一致（md 对应原 px-4 py-1.5 text-sm，sm 对应原 px-3 py-1 text-xs），
// 只额外给选中项加了 font-medium 作为非颜色标记。

import { cn } from '@/lib/utils'

export interface SegmentedOption<T> {
  value: T
  label: string
  disabled?: boolean
}

interface SegmentedProps<T> {
  /** 无障碍名称。有可见标题时传 labelledBy 代替 */
  label?: string
  labelledBy?: string
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  /** 整组禁用（如切换计算后端时正在重载模型） */
  disabled?: boolean
  className?: string
}

export function Segmented<T extends string | number>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  size = 'md',
  disabled,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-50',
              size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-sm',
              isActive
                ? 'border-primary bg-primary font-medium text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
