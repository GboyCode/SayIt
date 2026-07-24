import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { message } from '@tauri-apps/plugin-dialog'
import { Check, Download, FolderOpen, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import {
  exportConfigFile,
  exportFullFile,
  importConfigFile,
  importFullFile,
  onBackupExportProgress,
  type BackupExportProgress,
} from '@/services/backup'

type BusyAction = 'exportConfig' | 'exportFull' | 'importConfig' | 'importFull' | null

const phaseLabels: Record<BackupExportProgress['phase'], string> = {
  preparing: '正在准备备份…',
  packingData: '正在整理配置和历史记录…',
  packingAudio: '正在打包录音文件…',
  finalizing: '正在完成备份…',
  completed: '备份完成',
  failed: '备份失败',
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function SavedPath({
  label,
  path,
  onOpen,
  success = false,
}: {
  label: string
  path: string
  onOpen: () => void
  success?: boolean
}) {
  return (
    <div className={`mt-2 flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-xs ${success ? 'bg-success/10 text-success' : 'bg-muted/50 text-muted-foreground'}`}>
      {success && <Check className="h-3.5 w-3.5 shrink-0" />}
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground/80" title={path}>{path}</span>
      <Tooltip content="打开所在文件夹">
        <button
          type="button"
          onClick={onOpen}
          aria-label="打开所在文件夹"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  )
}

function ExportProgress({ progress }: { progress: BackupExportProgress }) {
  const percent = Math.max(0, Math.min(100, progress.percent))
  const detail = progress.phase === 'packingAudio' && progress.totalFiles > 0
    ? `${progress.processedFiles}/${progress.totalFiles} 个录音 · ${formatBytes(progress.processedBytes)} / ${formatBytes(progress.totalBytes)}`
    : progress.currentFile || '请稍候'

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{phaseLabels[progress.phase]}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(percent)}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="全部数据导出进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80" title={progress.filePath}>
        保存到 {progress.filePath}
      </p>
    </div>
  )
}

export default function BackupSection() {
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [configPath, setConfigPath] = useState('')
  const [fullPath, setFullPath] = useState('')
  const [fullProgress, setFullProgress] = useState<BackupExportProgress | null>(null)

  useEffect(() => {
    const unlisten = onBackupExportProgress((progress) => {
      setFullProgress(progress)
      if (progress.filePath) setFullPath(progress.filePath)
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  const isBusy = busyAction !== null
  const fullExportRunning = fullProgress?.status === 'running'
  const fullProgressError = useMemo(
    () => fullProgress?.status === 'failed' ? fullProgress.error || '未知错误' : '',
    [fullProgress],
  )

  const revealFile = (filePath: string) => {
    void invoke('reveal_file_in_folder', { filePath })
  }

  const handleExportConfig = async () => {
    setBusyAction('exportConfig')
    try {
      const result = await exportConfigFile()
      if (result.filePath) setConfigPath(result.filePath)
    } catch (error) {
      await message(`导出失败：${String(error)}`, { title: '导出失败', kind: 'error' })
    } finally {
      setBusyAction(null)
    }
  }

  const handleExportFull = async () => {
    setBusyAction('exportFull')
    setFullProgress(null)
    try {
      const result = await exportFullFile()
      if (result.filePath) setFullPath(result.filePath)
    } catch (error) {
      await message(`导出失败：${String(error)}`, { title: '导出失败', kind: 'error' })
    } finally {
      setBusyAction(null)
    }
  }

  const handleImport = async (kind: 'config' | 'full') => {
    setBusyAction(kind === 'config' ? 'importConfig' : 'importFull')
    try {
      if (kind === 'config') await importConfigFile()
      else await importFullFile()
    } catch (error) {
      await message(`导入失败：${String(error)}`, { title: '导入失败', kind: 'error' })
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="text-lg font-semibold">备份与迁移</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          用于换机、重装或定期备份。导入会覆盖现有数据，请先确认。
        </p>

        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">配置</p>
              <p className="mt-0.5 text-xs text-muted-foreground">仅设置、密钥、热词与提示词，文件小、便于日常备份</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExportConfig()} disabled={isBusy}>
                {busyAction === 'exportConfig' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {busyAction === 'exportConfig' ? '正在导出' : '导出'}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleImport('config')} disabled={isBusy}>
                {busyAction === 'importConfig' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {busyAction === 'importConfig' ? '正在导入' : '导入'}
              </Button>
            </div>
          </div>
          {configPath && (
            <SavedPath label="已保存到" path={configPath} success onOpen={() => revealFile(configPath)} />
          )}
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">全部数据</p>
              <p className="mt-0.5 text-xs text-muted-foreground">在配置基础上，额外包含历史记录与录音，适合完整迁移</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExportFull()} disabled={isBusy}>
                {busyAction === 'exportFull' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {busyAction === 'exportFull' ? '正在打包' : '导出'}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleImport('full')} disabled={isBusy}>
                {busyAction === 'importFull' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {busyAction === 'importFull' ? '正在导入' : '导入'}
              </Button>
            </div>
          </div>

          {fullExportRunning && fullProgress && <ExportProgress progress={fullProgress} />}
          {fullProgress?.status === 'completed' && fullPath && (
            <SavedPath label="已保存到" path={fullPath} success onOpen={() => revealFile(fullPath)} />
          )}
          {fullProgressError && (
            <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              导出失败：{fullProgressError}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
