import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, Crosshair } from 'lucide-react'
import * as bridge from '@/services/bridge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'

/**
 * 只展示"真正决定命中"的条件。
 * 写了进程名的规则一律只按进程名判定（见 promptRouter.matchesAppPromptRule），
 * 此时再把窗口标题/类名列出来会让人误以为它们也会触发。
 */
function formatMatcher(rule: AppPromptRule) {
  if (rule.matcher.processNames.length > 0) {
    return `进程: ${rule.matcher.processNames.join(', ')}`
  }
  const parts: string[] = []
  if (rule.matcher.windowTitleIncludes?.length) {
    parts.push(`窗口: ${rule.matcher.windowTitleIncludes.join(', ')}`)
  }
  if (rule.matcher.windowClasses?.length) {
    parts.push(`类名: ${rule.matcher.windowClasses.join(', ')}`)
  }
  if (rule.matcher.automationIds?.length) {
    parts.push(`控件: ${rule.matcher.automationIds.join(', ')}`)
  }
  return parts.join(' | ')
}

function isSameRule(left: AppPromptRule, right: AppPromptRule) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export default function AppPromptRulesSection({
  presets,
  rules,
  onSaveRule,
  onResetRule,
  onCreateRule,
  onDeleteRule,
}: {
  presets: PromptPreset[]
  rules: AppPromptRule[]
  onSaveRule: (rule: AppPromptRule) => Promise<void> | void
  onResetRule: (ruleId: string) => Promise<void> | void
  onCreateRule: (draft: { name: string; processNames: string[]; presetId?: string; promptAppend: string }) => Promise<void> | void
  onDeleteRule: (ruleId: string) => Promise<void> | void
}) {
  const [drafts, setDrafts] = useState<Record<string, AppPromptRule>>({})
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)
  // 新建规则表单（null = 未展开）
  const [newRule, setNewRule] = useState<{ name: string; processName: string; presetId: string; promptAppend: string } | null>(null)
  // 「检测当前应用」倒计时：给用户时间切到目标程序，否则测到的就是 SayIt 自己
  const [countdown, setCountdown] = useState(0)
  const [detectHint, setDetectHint] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const nextDrafts: Record<string, AppPromptRule> = {}
    const expanded = new Set<string>()
    for (const rule of rules) {
      nextDrafts[rule.id] = { ...rule, matcher: { ...rule.matcher } }
      if (rule.enabled) {
        expanded.add(rule.id)
      }
    }
    setDrafts(nextDrafts)
    setExpandedRules(expanded)
  }, [rules])

  const presetOptions = useMemo(
    () => [{ id: '', name: '继承当前全局预设' }, ...presets.map((preset) => ({ id: preset.id, name: preset.name }))],
    [presets],
  )

  const updateDraft = (ruleId: string, patch: Partial<AppPromptRule>) => {
    setDrafts((current) => {
      const existing = current[ruleId]
      if (!existing) return current
      return {
        ...current,
        [ruleId]: {
          ...existing,
          ...patch,
        },
      }
    })
  }

  const toggleExpanded = (ruleId: string) => {
    setExpandedRules((current) => {
      const next = new Set(current)
      if (next.has(ruleId)) {
        next.delete(ruleId)
      } else {
        next.add(ruleId)
      }
      return next
    })
  }

  /**
   * 检测当前应用：先倒计时，让用户切到目标程序，再读前台窗口的进程名。
   * 直接读的话只会读到 SayIt 自己（用户正在点这个按钮）。
   */
  const detectCurrentApp = async () => {
    setDetectHint('')
    for (let s = 3; s > 0; s -= 1) {
      setCountdown(s)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    setCountdown(0)
    try {
      const ctx = await bridge.getActiveAppContext()
      const raw = String((ctx?.processName as string) || '').trim()
      if (!raw) {
        setDetectHint('没能读到进程名，请手动填写')
        return
      }
      if (raw.toLowerCase() === 'sayit.exe') {
        setDetectHint('检测到的是 SayIt 自己，请在倒计时内切换到目标程序')
        return
      }
      setNewRule((current) => (current ? { ...current, processName: raw } : current))
      const title = String((ctx?.windowTitle as string) || '').trim()
      setDetectHint(`已检测到：${raw}${title ? `（${title}）` : ''}`)
    } catch {
      setDetectHint('检测失败，请手动填写进程名')
    }
  }

  const handleCreate = async () => {
    if (!newRule) return
    const name = newRule.name.trim()
    const processNames = newRule.processName
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!name || processNames.length === 0) return
    await onCreateRule({
      name,
      processNames,
      presetId: newRule.presetId || undefined,
      promptAppend: newRule.promptAppend.trim(),
    })
    setNewRule(null)
    setDetectHint('')
  }

  const handleSave = async (ruleId: string) => {
    const draft = drafts[ruleId]
    if (!draft) return
    setSavingId(ruleId)
    try {
      await onSaveRule(draft)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">应用 Prompt 规则</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              根据当前输入的应用自动切换或增强 Prompt，按应用的进程识别。内置 Teams、Outlook、Kiro、Codex、VSCode、Cursor、记事本、微信、QQ，也可以自己添加。
            </p>
          </div>
          {!newRule && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => { setNewRule({ name: '', processName: '', presetId: '', promptAppend: '' }); setDetectHint('') }}
            >
              <Plus className="h-3.5 w-3.5" />
              新建规则
            </Button>
          )}
        </div>

        {/* 新建规则表单 */}
        {newRule && (
          <div className="rounded-lg border border-dashed p-4">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">应用名称</label>
                  <input
                    value={newRule.name}
                    onChange={(event) => setNewRule({ ...newRule, name: event.target.value })}
                    placeholder="例如：飞书"
                    className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">进程名</label>
                  <div className="flex gap-2">
                    <input
                      value={newRule.processName}
                      onChange={(event) => setNewRule({ ...newRule, processName: event.target.value })}
                      placeholder="例如：feishu.exe"
                      className="w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      disabled={countdown > 0}
                      onClick={() => void detectCurrentApp()}
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                      {countdown > 0 ? `${countdown} 秒…` : '检测当前应用'}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {countdown > 0
                  ? '请在倒计时内切换到目标程序，松手不用管这里。'
                  : detectHint || '点「检测当前应用」后切到目标程序，会自动填入它的进程名；多个进程名可用逗号分隔。'}
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">基础预设</label>
                <Select
                  value={newRule.presetId}
                  onChange={(value) => setNewRule({ ...newRule, presetId: value })}
                  options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">附加提示词</label>
                <textarea
                  value={newRule.promptAppend}
                  onChange={(event) => setNewRule({ ...newRule, promptAppend: event.target.value })}
                  rows={2}
                  className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                  placeholder="补充这个应用的语言风格或格式要求（可留空）"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setNewRule(null); setDetectHint('') }}
                  className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  取消
                </button>
                <button
                  disabled={!newRule.name.trim() || !newRule.processName.trim()}
                  onClick={() => void handleCreate()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {rules.map((rule) => {
            const draft = drafts[rule.id] || rule
            const dirty = !isSameRule(draft, rule)
            const isExpanded = expandedRules.has(rule.id)
            
            return (
              <div key={rule.id} className="rounded-lg border bg-card">
                {/* 标题栏 */}
                <div
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-t-lg bg-muted/30 px-4 py-2.5"
                  onClick={() => toggleExpanded(rule.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="shrink-0">
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                    
                    <p className="text-sm font-medium">{rule.name}</p>
                    <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground/50">{rule.builtin ? '内置' : '自定义'}</span>
                    <p className="ml-1 truncate text-xs text-muted-foreground/50">{formatMatcher(rule)}</p>
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={draft.enabled}
                      onChange={() => updateDraft(rule.id, { enabled: !draft.enabled })}
                    />
                  </div>
                </div>

                {/* 展开内容 */}
                {isExpanded && (
                  <div className="border-t px-4 pb-3 pt-3">
                    <div className="space-y-3">
                      {!rule.builtin && (
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-foreground">进程名</label>
                          <input
                            value={(draft.matcher.processNames || []).join(', ')}
                            onChange={(event) => updateDraft(rule.id, {
                              matcher: {
                                ...draft.matcher,
                                processNames: event.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
                              },
                            })}
                            placeholder="例如：feishu.exe"
                            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">基础预设</label>
                        <Select
                          value={draft.presetId || ''}
                          onChange={(value) => updateDraft(rule.id, { presetId: value || undefined })}
                          options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">附加提示词</label>
                        <textarea
                          value={draft.promptAppend}
                          onChange={(event) => updateDraft(rule.id, { promptAppend: event.target.value })}
                          rows={1}
                          className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                          style={{ fieldSizing: 'content' as never, minHeight: '2.25rem', maxHeight: '7rem' }}
                          placeholder="补充当前应用的语言风格或格式要求"
                        />
                      </div>

                      <div className="flex justify-end gap-2">
                        {rule.builtin ? (
                          <button
                            onClick={() => void onResetRule(rule.id)}
                            className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                          >
                            恢复默认
                          </button>
                        ) : deletingId === rule.id ? (
                          <>
                            <button
                              onClick={() => setDeletingId(null)}
                              className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => { setDeletingId(null); void onDeleteRule(rule.id) }}
                              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground transition-colors hover:bg-destructive/90"
                            >
                              确认删除
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeletingId(rule.id)}
                            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除
                          </button>
                        )}
                        <button
                          disabled={!dirty || savingId === rule.id}
                          onClick={() => void handleSave(rule.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {savingId === rule.id ? '保存中...' : '保存规则'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
