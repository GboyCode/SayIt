import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { BUILTIN_PRESETS, type PromptPreset } from '@/services/store'
import { ComboShortcutInput, type ShortcutValidate } from './ShortcutInputs'
import { displayAccelerator } from './utils'

export default function PromptPresetSection({
  presets,
  activePresetId,
  editingPreset,
  presetShortcuts,
  editingShortcut,
  onSelectPreset,
  onStartNewPreset,
  onStartEditing,
  onEditingPresetChange,
  onEditingShortcutChange,
  onCancelEditing,
  onSavePreset,
  onDeletePreset,
  onMovePreset,
  validateShortcut,
}: {
  presets: PromptPreset[]
  activePresetId: string
  editingPreset: PromptPreset | null
  presetShortcuts: Record<string, string>
  /** 编辑中的快捷键草稿。**不即时落库** —— 见下方 onEditingShortcutChange 的说明 */
  editingShortcut: string
  onSelectPreset: (id: string) => void
  onStartNewPreset: () => void
  onStartEditing: (preset: PromptPreset) => void
  onEditingPresetChange: (preset: PromptPreset) => void
  /**
   * 只改草稿，保存时才写库。
   * 以前这里是即时写库的，于是：给还没保存的新模式设了快捷键再点取消，会留下一条指向
   * 不存在模式的快捷键；而且写入时为保证组合键唯一会把占用同一组合键的旧模式清掉，
   * 取消后那个旧模式的快捷键也回不来了。
   */
  onEditingShortcutChange: (accelerator: string) => void
  onCancelEditing: () => void
  onSavePreset: (preset: PromptPreset) => void
  onDeletePreset: (id: string) => void
  /** 拖拽调整自定义模式的顺序（下标是在"自定义"这一段里的下标；内置顺序固定） */
  onMovePreset: (from: number, to: number) => void
  validateShortcut?: ShortcutValidate
}) {
  const presetSortable = useSortable({ onMove: onMovePreset })
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [templateId, setTemplateId] = useState('')

  // 是否在"新建"（草稿的 id 还不在已有列表里）
  const isCreating = !!editingPreset && !presets.some((preset) => preset.id === editingPreset.id)

  // 打开表单时把焦点放到名称框。
  // 依赖**只能**是 id / builtin 这类原始值：editingPreset 每次输入都是新对象，
  // 把它列进依赖会导致每敲一个字都重新聚焦，光标从提示词框被拽回名称框。
  const editingId = editingPreset?.id ?? null
  const editingBuiltin = !!editingPreset?.builtin
  useEffect(() => {
    if (!editingId) {
      setTemplateId('')
      return
    }
    if (!editingBuiltin) nameInputRef.current?.focus()
  }, [editingId, editingBuiltin])

  const applyTemplate = (id: string) => {
    setTemplateId(id)
    if (!id || !editingPreset) return
    const source = presets.find((preset) => preset.id === id)
    if (source) onEditingPresetChange({ ...editingPreset, systemPrompt: source.systemPrompt })
  }

  const missingName = !!editingPreset && !editingPreset.name.trim()
  const missingPrompt = !!editingPreset && !editingPreset.systemPrompt.trim()

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">润色模式</h2>
            <p className="text-xs text-muted-foreground">选择或自定义 AI 对语音文本的处理方式。</p>
          </div>
          <button
            onClick={onStartNewPreset}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
          >
            <Plus className="h-3 w-3" /> 新建
          </button>
        </div>

        {/* 编辑/新建表单放在列表**上方**：以前在整个列表下面，列表一长就在屏幕外，
            点了「新建」看着像没反应。 */}
        {editingPreset && (
          <div className="mb-4 space-y-3 rounded-lg border border-primary/30 bg-muted p-4">
            <p className="text-sm font-medium">{isCreating ? '新建润色模式' : `编辑「${editingPreset.name}」`}</p>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">名称</label>
              <input
                ref={nameInputRef}
                value={editingPreset.name}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, name: event.target.value })}
                placeholder="例如：会议纪要整理"
                className="h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm"
                disabled={editingPreset.builtin}
              />
            </div>

            {/* 新建时给个起点：从零写 System Prompt 门槛太高，内置模式本身就是好模板 */}
            {isCreating && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">以现有模式为模板（可选）</label>
                <Select
                  value={templateId}
                  onChange={applyTemplate}
                  options={[
                    { value: '', label: '不使用模板，自己写' },
                    ...presets.map((preset) => ({
                      value: preset.id,
                      label: preset.builtin ? `${preset.name}（内置）` : preset.name,
                    })),
                  ]}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  选中后会把该模式的提示词填入下面，改几句就能用。
                </p>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">系统提示词（System Prompt）</label>
              <p className="mb-2 text-xs text-muted-foreground">
                定义 AI 的角色和处理规则，语音文本会自动附加为用户消息。
              </p>
              <textarea
                value={editingPreset.systemPrompt}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, systemPrompt: event.target.value })}
                placeholder="定义 AI 的角色、行为和处理规则..."
                rows={8}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
              />
            </div>

            <div className="border-t border-border/60 pt-3">
              <ComboShortcutInput
                value={editingShortcut}
                onChange={onEditingShortcutChange}
                validate={validateShortcut}
                label="快捷键（可选）"
                description="设置组合键随时切换到此模式，如 Alt+1、Alt+2（需含修饰键）。保存后生效"
                comboOnly
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              {/* 保存不可点时说明原因，而不是干灰着 */}
              {(missingName || missingPrompt) && (
                <span className="mr-auto text-xs text-muted-foreground">
                  {missingName && missingPrompt ? '请填写名称和提示词' : missingName ? '请填写名称' : '请填写提示词'}
                </span>
              )}

              {editingPreset.builtin && (
                <button
                  onClick={() => {
                    const original = BUILTIN_PRESETS.find((builtin) => builtin.id === editingPreset.id)
                    if (original) onEditingPresetChange({ ...original })
                  }}
                  className="px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  恢复默认
                </button>
              )}

              <button
                onClick={onCancelEditing}
                className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent"
              >
                取消
              </button>
              <button
                disabled={missingName || missingPrompt}
                onClick={() => onSavePreset(editingPreset)}
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {presets.map((preset) => {
            const customPresets = presets.filter((item) => !item.builtin)
            const customIndex = customPresets.findIndex((item) => item.id === preset.id)
            const canMove = !preset.builtin && customPresets.length > 1
            return (
              <div
                key={preset.id}
                {...(canMove ? presetSortable.rowProps(customIndex) : {})}
                className={`group cursor-pointer rounded-lg border p-3 transition-colors ${activePresetId === preset.id
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border hover:bg-accent/50'
                  } ${canMove ? presetSortable.rowClassName(customIndex) : ''}`}
                onClick={() => onSelectPreset(preset.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {canMove && (
                      <DragHandle
                        {...presetSortable.handleProps(customIndex, `拖动 ${preset.name}`)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    )}
                    <div
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${activePresetId === preset.id ? 'border-primary' : 'border-muted-foreground/40'
                        }`}
                    >
                      {activePresetId === preset.id && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{preset.name}</p>
                        {preset.builtin && (
                          <span className="rounded border px-1 text-xs text-muted-foreground">内置</span>
                        )}
                        {presetShortcuts[preset.id] && (
                          <span className="rounded border border-primary/30 bg-primary/5 px-1.5 text-xs text-muted-foreground">
                            {displayAccelerator(presetShortcuts[preset.id]).join('+')}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{preset.systemPrompt.slice(0, 60)}...</p>
                    </div>
                  </div>

                  <div className="ml-2 flex shrink-0 items-center gap-1">
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        onStartEditing({ ...preset })
                      }}
                      className="rounded p-1.5 hover:bg-accent"
                      aria-label="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>

                    {!preset.builtin && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeletePreset(preset.id)
                        }}
                        className="rounded p-1.5 hover:bg-accent"
                        aria-label="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
