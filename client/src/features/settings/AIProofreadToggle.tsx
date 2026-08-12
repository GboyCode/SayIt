// AI 整理开关卡片（独立组件）
// 状态接入全局 store，与标题栏的开关保持同步

import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { toggleAiEnabled } from '@/stores/aiEnabled'
import { useT } from '@/i18n/useT'

export default function AIProofreadToggle() {
  const t = useT()
  const aiEnabled = useAiEnabled()

  return (
    <Card>
      <CardContent className="p-6">
        {/* min-w-0 + gap：最小窗口下说明文字要能挤，不能把开关顶出卡片 */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 id="ai-proofread-heading" className="text-lg font-semibold">{t('titleBar.aiCleanup')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {aiEnabled ? t('aiProofread.onDesc') : t('aiProofread.offDesc')}
            </p>
          </div>
          {/* 开关原来既没有 label 也没有 aria-label，相邻的标题也没关联——读屏念到的是
              一个没有名字的「切换按钮」 */}
          <Switch
            checked={aiEnabled}
            onChange={() => { void toggleAiEnabled() }}
            labelledBy="ai-proofread-heading"
            className="shrink-0"
          />
        </div>
      </CardContent>
    </Card>
  )
}
