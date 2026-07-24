// 备份 / 恢复：配置（JSON）与全部数据（zip，含音频）的导入导出。
//
// 配置导出：直接写入默认备份目录。
// 全量导出：直接写入默认备份目录，由 Rust 后台压缩，并通过事件汇报进度。
// 导入：选文件 → 二次确认（会覆盖当前数据）→ 调 Rust 恢复 → 提示并重启。
// 重启用自定义命令 restart_app（Tauri 内置 app.restart()），未依赖 process 插件。

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, confirm, message } from '@tauri-apps/plugin-dialog'

export interface ExportResult {
  canceled: boolean
  filePath: string | null
}

export interface BackupExportProgress {
  status: 'running' | 'completed' | 'failed'
  phase: 'preparing' | 'packingData' | 'packingAudio' | 'finalizing' | 'completed' | 'failed'
  filePath: string
  currentFile: string | null
  processedFiles: number
  totalFiles: number
  processedBytes: number
  totalBytes: number
  percent: number
  error: string | null
}

export function getBackupDirectory(): Promise<string> {
  return invoke<string>('get_backup_directory')
}

export function onBackupExportProgress(
  handler: (progress: BackupExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<BackupExportProgress>('backup-export-progress', (event) => handler(event.payload))
}

/** 导出配置（设置 / 供应商与密钥 / 热词 / Prompt）为 JSON。 */
export async function exportConfigFile(): Promise<ExportResult> {
  const path = await invoke<string>('export_config')
  return { canceled: false, filePath: path }
}

/** 导出全部数据（配置 + 历史 + 录音）为 zip，直接写入默认备份目录。 */
export async function exportFullFile(): Promise<ExportResult> {
  const path = await invoke<string>('export_full')
  return { canceled: false, filePath: path }
}

/** 导入结果：done = 已导入（即将重启）；canceled = 用户取消。 */
export type ImportOutcome = 'done' | 'canceled'

async function pickConfirmImport(kind: 'config' | 'full'): Promise<ImportOutcome> {
  const filters =
    kind === 'config'
      ? [{ name: 'SayIt 配置', extensions: ['json'] }]
      : [{ name: 'SayIt 备份', extensions: ['zip'] }]

  const picked = await open({ multiple: false, directory: false, filters })
  const inPath = typeof picked === 'string' ? picked : null
  if (!inPath) return 'canceled'

  const what =
    kind === 'config'
      ? '设置、供应商配置与密钥、热词、Prompt'
      : '全部数据（设置、历史记录与录音）'
  const ok = await confirm(`导入将用备份覆盖当前的${what}，此操作无法撤销。确定继续吗？`, {
    title: '确认导入',
    kind: 'warning',
    okLabel: '覆盖导入',
    cancelLabel: '取消',
  })
  if (!ok) return 'canceled'

  await invoke(kind === 'config' ? 'import_config' : 'import_full', { inPath })
  await message('导入成功，应用将重启以使更改生效。', { title: '导入完成' })
  await invoke('restart_app')
  return 'done'
}

export const importConfigFile = () => pickConfirmImport('config')
export const importFullFile = () => pickConfirmImport('full')
