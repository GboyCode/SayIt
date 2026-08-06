// 本地模式配置面板 — 模型管理

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Copy, Check, ChevronDown, HardDrive, Loader2, Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback } from '@/components/ui/feedback'
import { Segmented } from '@/components/ui/segmented'
import { Modal } from '@/components/ui/modal'
import { getSetting, setSetting } from '@/services/store'
import { refreshModeStatus } from '@/stores/modeStatus'
import { reconnectProvider } from '@/services/recorder'
import { describeDownloadError } from '@/lib/errorMessages'

/** 模型存储位置变更的窗口事件：次级设置卡片（LocalModeAdvancedSection）里改了
 *  目录后，通知模型列表卡片刷新已下载状态——两个卡片各自持有状态、不在同一组件树。 */
const MODELS_DIR_CHANGED_EVENT = 'sayit:models-dir-changed'

interface ModelFile {
  name: string
  url: string
  size_bytes: number
  sha256: string | null
}

interface DownloadSource {
  source: string
  files: ModelFile[]
}

interface ModelInfo {
  id: string
  name: string
  description: string
  model_type: string
  total_size_bytes: number
  languages: string[]
  sources: DownloadSource[]
  archive_url?: string
  speed?: number
  accuracy?: number
  recommended?: boolean
  memory_mb?: number
  languages_label?: string
  quant?: string
  featured?: boolean
}

interface LocalModelInfo {
  id: string
  name: string
  model_type: string
  total_size_bytes: number
  path: string
  complete: boolean
}

interface DownloadProgress {
  model_id: string
  file_name: string
  downloaded_bytes: number
  total_bytes: number
  percent: number
  file_index: number
  file_count: number
  status: string
  error: string | null
}

interface ModelsDirInfo {
  current: string
  default_dir: string
  is_custom: boolean
}

// 本地 GGUF 引擎的诊断信息（Rust 命令 gguf_asr_diagnostics）
interface GgufDevice {
  kind: string
  name: string
  memory_mb: number
}

interface GgufDiagnostics {
  devices: GgufDevice[]
  current_backend: string | null
  native_version: string
  process_memory_mb: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 常驻内存的展示：350 → "~350 MB"，1400 → "~1.4 GB"。
 *  统一按 1024 进制、统一写「GB/MB」——同一页原来出现过 /1000 的「~1.4G」、
 *  /1024³ 的「1.4 GB」和 /1024 的「8 GB」三种口径，用户没法横向比。 */
function formatMemory(mb: number): string {
  if (mb < 1024) return `~${mb} MB`
  return `~${(mb / 1024).toFixed(1)} GB`
}

/** 下载源的展示名。同一个源在模型卡里叫「HF Mirror（国内推荐）」、在离线指引里叫
 *  「HF Mirror (China)」，收敛到一处。 */
function sourceLabel(source: string): string {
  return source === 'HuggingFace Mirror' ? 'HF Mirror（国内推荐）' : source
}

/** 速度/准确度评级：10 分制细柱状条（无数字），与参数排同一行 */
function MiniRating({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100))
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{label}</span>
        {/* 纯图标按钮必须自带 aria-label：Tooltip 只响应鼠标悬停，键盘和读屏用户拿不到它 */}
        <Tooltip content={copied ? '已复制' : '复制链接'}>
          <button
            type="button"
            aria-label={copied ? `已复制 ${label} 的链接` : `复制 ${label} 的链接`}
            onClick={() => {
              void navigator.clipboard.writeText(url)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-success-strong" aria-hidden />
              : <Copy className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </Tooltip>
      </div>
      <code className="mt-1 block select-all break-all text-[11px] leading-relaxed text-muted-foreground">{url}</code>
    </div>
  )
}

function OfflineGuideDialog({ models, onClose }: { models: ModelInfo[]; onClose: () => void }) {
  const [selectedSource, setSelectedSource] = useState(0)

  // 收集所有源名称
  const sourceNames = models[0]?.sources.map((s) => s.source) || []

  return (
    <Modal title="离线下载指引" onClose={onClose} showCloseButton panelClassName="w-[640px]">
      <>
        {/* 步骤 */}
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>1. 点击模型名称旁的文件夹图标，打开对应模型目录</p>
          <p>2. 复制下方链接，在浏览器中下载文件，放入该目录</p>
          <p>3. 刷新页面即可自动识别</p>
        </div>

        {/* 源切换 */}
        <div role="radiogroup" aria-label="下载源" className="mt-4 flex gap-1 rounded-lg border border-border p-0.5">
          {sourceNames.map((name, i) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selectedSource === i}
              onClick={() => setSelectedSource(i)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${selectedSource === i
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {sourceLabel(name)}
            </button>
          ))}
        </div>

        {/* 模型文件链接 */}
        <div className="mt-4 space-y-4">
          {models.map((model) => {
            // 某模型没有当前标签对应的源时，回退到它的第一个源（防御，正常不会发生：
            // catalog 的测试保证所有模型提供同一组源）
            const source = model.sources[selectedSource] ?? model.sources[0]
            const isArchive = !source && !!model.archive_url
            if (!source && !isArchive) return null
            // GitHub 地址用国内代理加速手动下载
            const archiveUrl = model.archive_url
              ? (model.archive_url.startsWith('https://github.com/')
                ? `https://gh-proxy.com/${model.archive_url}`
                : model.archive_url)
              : ''
            return (
              <div key={model.id}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{model.name}</span>
                  <code className="rounded bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">{model.id}/</code>
                  <Tooltip content="打开模型文件夹">
                    <button
                      type="button"
                      aria-label={`打开 ${model.name} 的模型文件夹`}
                      onClick={() => void invoke<string>('open_model_folder', { modelId: model.id })}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </Tooltip>
                </div>
                <div className="space-y-1.5">
                  {source ? (
                    source.files.map((file) => (
                      <CopyLink key={file.name} url={file.url} label={file.name} />
                    ))
                  ) : (
                    <>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        压缩包，下载后解压到上面的模型文件夹（解压出 .onnx 等文件直接放入该目录即可）。
                      </p>
                      <CopyLink url={archiveUrl} label="模型压缩包 (.tar.bz2)" />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </>
    </Modal>
  )
}

/** 模型存储位置：查看 / 更改 / 恢复默认。更改时可选把已下载模型一并迁移。 */
function ModelsDirSection({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<ModelsDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 待确认的目录变更：null=无。dir=null 表示恢复默认。
  const [pending, setPending] = useState<{ dir: string | null } | null>(null)

  const load = async () => {
    try { setInfo(await invoke<ModelsDirInfo>('get_models_dir')) } catch { /* ignore */ }
  }
  useEffect(() => { void load() }, [])

  async function pickDir() {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择模型存储位置' })
      if (typeof selected !== 'string') return // 取消
      if (info && selected === info.current) return // 未变化
      setPending({ dir: selected })
    } catch (err) {
      setError(String(err))
    }
  }

  function requestResetDefault() {
    if (!info || !info.is_custom) return
    setPending({ dir: null })
  }

  async function applyChange() {
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      // 一律自动迁移已下载的模型到新目录
      await invoke<string>('set_models_dir', { dir: pending.dir, moveExisting: true })
      setPending(null)
      await load()
      onChanged() // 路径变了，刷新已下载模型列表
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-2 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">模型存储位置</h2>
          <Tooltip variant="light" content="本地模型体积较大，可以选择其他路径存放。已下载的模型在更换目录后会自动迁移。">
            <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-md bg-muted/30 px-3 py-2">
            <code className="min-w-0 flex-1 select-all truncate text-xs text-muted-foreground" title={info?.current}>
              {info?.current || '加载中…'}
            </code>
            {info?.is_custom && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">自定义</span>
            )}
            <Tooltip content="打开目录">
              <button
                type="button"
                aria-label="打开模型存储目录"
                onClick={() => void invoke<string>('open_models_folder')}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
          <Button size="sm" variant="outline" onClick={() => void pickDir()} disabled={busy}>
            更改位置
          </Button>
          {info?.is_custom && (
            <Button size="sm" variant="ghost" onClick={requestResetDefault} disabled={busy}>
              恢复默认
            </Button>
          )}
        </div>

        {error && <Feedback className="mt-3" tone="error" message="模型目录操作失败。" detail={error} />}
      </CardContent>

      {pending && (
        <Modal
          title={pending.dir === null ? '恢复默认模型位置' : '更改模型存储位置'}
          onClose={() => setPending(null)}
          locked={busy}
          panelClassName="w-[420px]"
        >
          <>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              新位置：{pending.dir === null ? (info?.default_dir || '默认目录') : pending.dir}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              已下载的模型会自动迁移到新位置，跨磁盘移动大文件可能需要一些时间，请勿中途退出。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy}>取消</Button>
              <Button size="sm" onClick={() => void applyChange()} disabled={busy}>
                {busy ? (<><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />处理中…</>) : '确定'}
              </Button>
            </div>
          </>
        </Modal>
      )}
    </Card>
  )
}

export default function LocalModeSection() {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [downloadedModels, setDownloadedModels] = useState<LocalModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadSource, setDownloadSource] = useState('HuggingFace Mirror')
  const [preloadingModelId, setPreloadingModelId] = useState('')
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({})
  // 「更多模型」折叠。默认只展示 featured 的小/中/大三个，其余点开才看到。
  const [showMore, setShowMore] = useState(false)
  // 模型清单的加载状态。原来 loadData 的 catch 是空的，list_available_models 失败时
  // 页面只剩标题 + 下载源一行 + 下面一片空白，看起来像"本地模式坏了"。
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  // 离线下载指引的开关提到这一层：下载失败时也要能把用户直接送进去
  const [offlineGuideOpen, setOfflineGuideOpen] = useState(false)
  // 检测到的 GPU 摘要。选模型时最该知道的就是"这台机器什么水平"，
  // 而这条信息原来只出现在两张卡片之后的「计算后端」里。
  const [gpuSummary, setGpuSummary] = useState<string | null>(null)

  useEffect(() => {
    void loadData()
    const unlisten = listen<DownloadProgress>('model-download-progress', (event) => {
      const p = event.payload
      setDownloading((prev) => ({ ...prev, [p.model_id]: p }))
      if (p.status === 'completed' || p.status === 'failed') {
        void refreshDownloaded()
      }
    })
    // 模型存储位置（在次级设置卡片里）变更后，刷新已下载列表
    const onDirChanged = () => { void refreshDownloaded() }
    window.addEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    return () => {
      void unlisten.then((fn) => fn())
      window.removeEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    }
  }, [])

  async function loadData() {
    let available: ModelInfo[] = []
    try {
      const [a, downloaded] = await Promise.all([
        invoke<ModelInfo[]>('list_available_models'),
        invoke<LocalModelInfo[]>('list_downloaded_models'),
      ])
      available = a
      setAvailableModels(a)
      setDownloadedModels(downloaded)
      setListState('ready')
      setListError('')
    } catch (err) {
      setListState('error')
      setListError(String(err))
    }

    // GPU 摘要：只为在模型列表顶部给一句硬件背景，失败就当没有（不影响选模型）
    try {
      const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
      const gpus = diag.devices.filter((d) => d.kind !== 'cpu')
      setGpuSummary(gpus.length > 0
        ? gpus
          .map((d) => `${d.name.replace(/\((R|TM)\)/gi, '')}${d.memory_mb > 0 ? `（${(d.memory_mb / 1024).toFixed(0)} GB 显存）` : ''}`)
          .join('、')
        : '')
    } catch {
      setGpuSummary(null)
    }

    const selected = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
    setSelectedModelId(selected)
    setDownloadSource(await getSetting('localAsr.downloadSource', 'HuggingFace Mirror') as string)

    // 当前选中的模型在折叠区时自动展开，避免"当前模型在列表里找不到"
    const selectedInfo = available.find((m) => m.id === selected)
    if (selectedInfo && !selectedInfo.featured) setShowMore(true)
  }

  async function refreshDownloaded() {
    try {
      const downloaded = await invoke<LocalModelInfo[]>('list_downloaded_models')
      setDownloadedModels(downloaded)
    } catch { /* ignore */ }
  }

  async function handleDownload(modelId: string) {
    try {
      await invoke('download_model', { modelId, source: downloadSource })
      // 下载完成后自动选中并预加载
      setSelectedModelId(modelId)
      await setSetting('localAsr.modelId', modelId)
      void refreshModeStatus() // 同步左下角的引擎指示
      // provider 缓存着上次的就绪结果，不重连的话刚下载完第一次按快捷键仍会被判未就绪
      reconnectProvider()
      try {
        const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
        await invoke<string>('preload_local_model', { modelId, accelerator })
      } catch { /* ignore */ }
    } catch (err) {
      setDownloading((prev) => ({
        ...prev,
        [modelId]: {
          ...prev[modelId],
          model_id: modelId,
          file_name: '',
          downloaded_bytes: 0,
          total_bytes: 0,
          percent: 0,
          status: 'failed',
          error: String(err),
        },
      }))
    }
  }

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleDelete(modelId: string) {
    setConfirmDeleteId(null)
    try {
      await invoke('delete_model', { modelId })
      await refreshDownloaded()
      setDownloading((prev) => {
        const next = { ...prev }
        delete next[modelId]
        return next
      })
      // 删掉的可能正是当前选中的模型 → 就绪状态变了，通知徽标与侧栏指示
      void refreshModeStatus()
      // 同时让 provider 重新判定：否则它仍缓存着"已就绪"，模型都删了还能照常开录
      reconnectProvider()
    } catch { /* ignore */ }
  }

  /** 切到另一个下载源并立刻重试。下载失败时最常见的下一步就是这个。 */
  async function retryWithOtherSource(modelId: string) {
    const options = availableModels[0]?.sources.map((s) => s.source) ?? []
    const next = options.find((s) => s !== downloadSource) ?? downloadSource
    setDownloadSource(next)
    await setSetting('localAsr.downloadSource', next)
    setDownloading((prev) => {
      const rest = { ...prev }
      delete rest[modelId]
      return rest
    })
    await handleDownload(modelId)
  }

  async function handleSelectModel(modelId: string) {
    if (preloadingModelId) return // 防止切换/加载中重复触发
    setSelectedModelId(modelId)
    setPreloadingModelId(modelId)
    await setSetting('localAsr.modelId', modelId)
    void refreshModeStatus() // 同步左下角的引擎指示
    // 切到未下载的模型时也要让 provider 重新判定就绪
    reconnectProvider()
    try {
      const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
      await invoke<string>('preload_local_model', { modelId, accelerator })
    } catch { /* ignore */ } finally {
      setPreloadingModelId('')
    }
  }

  const downloadedIds = new Set(downloadedModels.filter((m) => m.complete).map((m) => m.id))

  // 小/中/大三个直接展示，其余折叠进「更多」。后端没标 featured 时全部展示兜底。
  const featuredModels = availableModels.some((m) => m.featured)
    ? availableModels.filter((m) => m.featured)
    : availableModels
  const moreModels = availableModels.filter((m) => !featuredModels.includes(m))
  const visibleModels = showMore ? [...featuredModels, ...moreModels] : featuredModels

  // 下载源按钮从 catalog 生成，保证和后端提供的源一一对应
  // （catalog 的测试保证了所有模型的源集合一致，取第一个模型的即可）
  const sourceOptions = availableModels[0]?.sources.map((s) => s.source) ?? []
  // 存储里的旧值（如已下线的 ModelScope）对不上任何源时，实际下载会回落到
  // 第一个源，这里让 UI 显示和实际行为一致
  const effectiveSource = sourceOptions.includes(downloadSource)
    ? downloadSource
    : sourceOptions[0] ?? downloadSource

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">语音识别模型</h2>
            <Tooltip content="打开模型所在文件夹">
              <button
                type="button"
                aria-label="打开模型所在文件夹"
                onClick={() => void invoke<string>('open_models_folder')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>

          {selectedModelId && downloadedIds.has(selectedModelId) && (
            <p className="mb-2 text-sm text-muted-foreground">
              当前模型：{availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId}
            </p>
          )}
          {selectedModelId && !downloadedIds.has(selectedModelId) && listState === 'ready' && (
            <Feedback
              className="mb-3"
              tone="warning"
              message="当前选中的模型还没下载，按下快捷键不会有反应。先下载它，或选一个已下载的模型。"
            />
          )}

          {/* 硬件背景。选模型是这一页最难的决定，而"这台机器什么水平"这条信息
              原来要往下翻两张卡才看得到。 */}
          {gpuSummary !== null && (
            <p className="mb-4 text-xs text-muted-foreground">
              {gpuSummary
                ? `检测到显卡：${gpuSummary}。识别会优先用 GPU，下面几个模型都能跑。`
                : '没检测到可用显卡，识别会用 CPU。越靠上的模型越快，建议从第一个开始试。'}
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span id="download-source-label" className="text-sm text-muted-foreground">下载源</span>
            <Segmented
              labelledBy="download-source-label"
              size="sm"
              value={effectiveSource}
              options={sourceOptions.map((src) => ({ value: src, label: sourceLabel(src) }))}
              onChange={(src) => { setDownloadSource(src); void setSetting('localAsr.downloadSource', src) }}
            />
          </div>

          {listState === 'loading' && (
            <p className="py-4 text-sm text-muted-foreground">正在读取模型清单…</p>
          )}
          {listState === 'error' && (
            <Feedback
              tone="error"
              message="读不到模型清单，所以下面是空的。这通常是客户端内部通信出了问题，重启 SayIt 一般能恢复。"
              detail={listError}
              actions={[{ label: '重新读取', onClick: () => void loadData() }]}
            />
          )}
          {listState === 'ready' && availableModels.length === 0 && (
            <Feedback
              tone="warning"
              message="这个版本没有附带可下载的模型清单。请更新到最新版，或改用云 API / 服务器模式。"
            />
          )}

          <div className="space-y-2">
            {visibleModels.map((model) => {
              const isDownloaded = downloadedIds.has(model.id)
              const isSelected = selectedModelId === model.id
              const progress = downloading[model.id]
              const isDownloading = progress?.status === 'downloading'

              return (
                <div
                  key={model.id}
                  className={`flex items-center justify-between rounded-lg border p-3 ${isSelected ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{model.name}</span>
                      {model.recommended && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">推荐</span>
                      )}
                      {isDownloaded && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="h-3 w-3" />已下载
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{model.description}</p>
                    {/* 参数行：评分柱状条 + 下载体积（硬盘图标）+ 内存占用 + 语种，一行小字。
                        量化档（Q8_0 之类）不展示——普通用户看不懂，文件名里查得到 */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                      {model.speed ? <MiniRating label="速度" value={model.speed} /> : null}
                      {model.accuracy ? <MiniRating label="准确度" value={model.accuracy} /> : null}
                      {model.total_size_bytes > 0 && (
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          {formatSize(model.total_size_bytes)}
                        </span>
                      )}
                      {model.memory_mb ? (
                        <><span aria-hidden>·</span><span>内存占用 {formatMemory(model.memory_mb)}</span></>
                      ) : null}
                      {model.languages_label ? (
                        <><span aria-hidden>·</span><span>{model.languages_label}</span></>
                      ) : null}
                    </div>
                    {isDownloading && progress && (
                      <div className="mt-2">
                        <div
                          role="progressbar"
                          aria-label={`正在下载 ${model.name}`}
                          aria-valuenow={Math.round(progress.percent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        {/* aria-live：下载过去对读屏用户是完全静默的 */}
                        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                          {progress.file_count > 1
                            ? `文件 ${progress.file_index}/${progress.file_count} — `
                            : ''}
                          {progress.file_name} — {progress.percent.toFixed(1)}%
                          {progress.total_bytes > 0
                            ? `（${formatSize(progress.downloaded_bytes)} / ${formatSize(progress.total_bytes)}）`
                            : `（${formatSize(progress.downloaded_bytes)}）`}
                        </p>
                      </div>
                    )}
                    {/* 下载失败原来只有一行原始异常。而"换个源重试"和"手动下载指引"这两条
                        降级路径就在同一张卡上，失败信息却不指向任何一个——用户会以为
                        本地模式不能用。现在直接把两个动作放进错误块里。 */}
                    {progress?.status === 'failed' && (() => {
                      const friendly = describeDownloadError(progress.error ?? '')
                      const hasOtherSource = sourceOptions.some((s) => s !== effectiveSource)
                      return (
                        <Feedback
                          className="mt-2"
                          tone="error"
                          message={friendly.message}
                          detail={friendly.detail}
                          actions={[
                            ...(friendly.action === 'switch_source' && hasOtherSource
                              ? [{
                                label: `换用 ${sourceLabel(sourceOptions.find((s) => s !== effectiveSource) ?? '')} 重试`,
                                onClick: () => void retryWithOtherSource(model.id),
                              }]
                              : [{ label: '重试', onClick: () => void handleDownload(model.id) }]),
                            { label: '手动下载指引', onClick: () => setOfflineGuideOpen(true) },
                          ]}
                        />
                      )
                    })()}
                  </div>
                  <div className="ml-3 flex gap-2">
                    {isDownloaded ? (
                      <>
                        {!isSelected && (
                          <Button
                            size="sm" variant="outline"
                            disabled={preloadingModelId !== ''}
                            onClick={() => void handleSelectModel(model.id)}
                          >
                            {preloadingModelId === model.id ? '加载中…' : '选择'}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(model.id)}>
                          删除
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void handleDownload(model.id)}
                        disabled={isDownloading}
                      >
                        {isDownloading ? '下载中…' : '下载'}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 更多模型：小众需求（更多语种 / 中间量化档）折叠收纳 */}
          {moreModels.length > 0 && (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore(!showMore)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {showMore ? '收起' : `更多模型（${moreModels.length}）`}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          )}

          {availableModels.length > 0 && (
            <button
              type="button"
              onClick={() => setOfflineGuideOpen(true)}
              className="mt-3 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
            >
              下载太慢或失败？查看手动下载指引
            </button>
          )}
        </CardContent>
      </Card>

      {offlineGuideOpen && (
        <OfflineGuideDialog models={availableModels} onClose={() => setOfflineGuideOpen(false)} />
      )}

      {/* 删除确认对话框 */}
      {confirmDeleteId && (
        <Modal title="确认删除模型" onClose={() => setConfirmDeleteId(null)} panelClassName="w-80">
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              删除后需要重新下载才能使用，确定要删除「{availableModels.find((m) => m.id === confirmDeleteId)?.name || confirmDeleteId}」吗？
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>取消</Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDelete(confirmDeleteId)}>删除</Button>
            </div>
          </>
        </Modal>
      )}
    </>
  )
}

/** 本地模式的次级设置：识别语言、计算后端、模型驻留、模型存储位置。
 *  单独一个导出，由 VoiceEnginePage 放在「识别测试」之后——选模型是主操作，
 *  这些是偶尔动一次的，不该排在测试入口前面。 */
export function LocalModeAdvancedSection() {
  const [asrLanguage, setAsrLanguage] = useState('auto')
  const [accelerator, setAccelerator] = useState('auto')
  const [unloadIdleMinutes, setUnloadIdleMinutes] = useState(0)
  const [devices, setDevices] = useState<GgufDevice[]>([])
  const [currentBackend, setCurrentBackend] = useState<string | null>(null)
  const [diagnosticsState, setDiagnosticsState] = useState<'loading' | 'ready' | 'error'>('loading')
  // 切换计算后端会就地重载当前模型（几秒），期间禁掉按钮防连点
  const [rebinding, setRebinding] = useState(false)

  useEffect(() => {
    void (async () => {
      setAsrLanguage(await getSetting('localAsr.language', 'auto') as string)
      setAccelerator(await getSetting('localAsr.accelerator', 'auto') as string)
      setUnloadIdleMinutes(Number(await getSetting('localAsr.unloadIdleMinutes', 0)) || 0)
      try {
        const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
        setDevices(diag.devices)
        setCurrentBackend(diag.current_backend)
        setDiagnosticsState('ready')
      } catch {
        setDiagnosticsState('error')
      }
    })()
  }, [])

  const gpuDevices = devices.filter((d) => d.kind !== 'cpu')
  const hasGpu = gpuDevices.length > 0
  const gpuSummary = gpuDevices
    .map((d) => `${d.name.replace(/\((R|TM)\)/gi, '')}${d.memory_mb > 0 ? `（${(d.memory_mb / 1024).toFixed(0)} GB）` : ''}`)
    .join('、')

  /** 切换计算后端。引擎按 (模型, 后端) 缓存，换后端要重载模型——
   *  就地重新预加载当前模型，让切换立刻生效而不是等下次口述。
   *  模型未下载时预加载会报错，忽略即可（下载后会按新设置加载）。 */
  async function handleSelectAccelerator(value: string) {
    if (rebinding) return
    setAccelerator(value)
    await setSetting('localAsr.accelerator', value)
    setRebinding(true)
    try {
      const modelId = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
      await invoke<string>('preload_local_model', { modelId, accelerator: value })
    } catch { /* ignore */ } finally {
      try {
        const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
        setDevices(diag.devices)
        setCurrentBackend(diag.current_backend)
        setDiagnosticsState('ready')
      } catch {
        setDiagnosticsState('error')
      }
      setRebinding(false)
    }
  }

  async function handleSelectUnloadIdle(value: number) {
    setUnloadIdleMinutes(value)
    try {
      await setSetting('localAsr.unloadIdleMinutes', value)
      await invoke('set_local_model_idle_unload', { idleMinutes: value })
    } catch { /* 重启后仍会从持久化设置读取；即时更新失败不影响识别 */ }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <h2 id="local-language-heading" className="mb-3 text-lg font-semibold">识别语言</h2>
          <Segmented
            labelledBy="local-language-heading"
            value={asrLanguage}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英文' },
            ]}
            onChange={(value) => { setAsrLanguage(value); void setSetting('localAsr.language', value) }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {/* 说清作用范围与真实收益：这个值只影响本地识别（作为 RunOptions.language
                传给引擎，auto = 让模型自己检测），云 API 模式没有这个选项，服务器模式
                有它自己的一份。固定语种的实际价值是压掉短句上的语种误判 —— 实测
                Qwen3 1.7B 会把 3 秒普通话判成粤语，见 gguf_asr.rs 的 language_detect_report。 */}
            只影响本地识别。大部分场景选「自动」；固定只说一种语言时选对应项更稳——短句上自动检测偶尔会认错语种（比如把普通话认成粤语）。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="accelerator-heading" className="text-lg font-semibold">计算后端</h2>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${diagnosticsState === 'ready' && hasGpu
              ? 'border-success/30 bg-success/10 text-success-strong'
              : 'border-border bg-muted/40 text-muted-foreground'
              }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${diagnosticsState === 'ready' && hasGpu ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden />
              {diagnosticsState === 'loading' ? '检测中' : diagnosticsState === 'error' ? '检测失败' : hasGpu ? 'GPU 已检测' : '仅 CPU'}
            </span>
          </div>
          <Segmented
            labelledBy="accelerator-heading"
            value={accelerator}
            disabled={rebinding}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'gpu', label: 'GPU' },
              { value: 'cpu', label: 'CPU' },
            ]}
            onChange={(value) => void handleSelectAccelerator(value)}
          />
          {diagnosticsState === 'ready' && hasGpu && (
            <p className="mt-2 text-xs text-muted-foreground">
              {gpuSummary}{currentBackend ? ` · 当前使用 ${currentBackend.toUpperCase()}` : ''}
            </p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {diagnosticsState === 'loading'
              ? '正在检测可用计算设备…'
              : diagnosticsState === 'error'
                ? '暂时无法读取计算设备状态，可保持「自动」并稍后重试。'
                : hasGpu
                  ? '建议保持「自动」，识别会优先使用 GPU；仅在兼容性或稳定性问题时切换到 CPU。'
                  : '没有可用 GPU 时会自动使用 CPU，不影响功能，仅识别速度稍慢。'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 id="unload-idle-heading" className="mb-1 text-lg font-semibold">模型驻留</h2>
          {/* 这四个选项是在"占着内存"和"下次说话要等模型重新加载"之间取舍，
              原来的说明只讲"会怎样"，不讲"你该不该关心" */}
          <p className="mb-3 text-xs text-muted-foreground">
            模型留在内存里能省掉下次口述前的加载时间，代价是一直占着几百 MB 到几 GB。
            内存吃紧就选一个时长，不缺内存保持默认。
          </p>
          <Segmented
            labelledBy="unload-idle-heading"
            value={unloadIdleMinutes}
            options={[
              { value: 0, label: '不自动卸载' },
              { value: 10, label: '10 分钟' },
              { value: 30, label: '30 分钟' },
              { value: 60, label: '1 小时' },
            ]}
            onChange={(value) => void handleSelectUnloadIdle(value)}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {unloadIdleMinutes === 0
              ? '当前：模型常驻内存，下一次识别无需重新加载。'
              : `当前：连续 ${unloadIdleMinutes === 60 ? '1 小时' : `${unloadIdleMinutes} 分钟`} 未使用后释放内存；下次识别会重新加载模型。`}
          </p>
        </CardContent>
      </Card>

      <ModelsDirSection onChanged={() => window.dispatchEvent(new Event(MODELS_DIR_CHANGED_EVENT))} />
    </>
  )
}
