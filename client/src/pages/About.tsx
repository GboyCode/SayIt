import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Github, Download, Loader2, CheckCircle } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { getAutoUpdateState, onAutoUpdateChange, checkAndUpdateNow, downloadNow, installNow, type AutoUpdateState } from '@/features/update/autoUpdate'
import { RELEASE_HIGHLIGHTS } from '@/features/update/releaseHighlights'
import appIcon from '@/assets/icon-128.png'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'

const currentVersion = __APP_VERSION__

function formatTimestamp(value: number | null | undefined) {
  if (!value) return t('about.neverChecked')
  // 时间格式跟界面语言：中文界面用 zh-CN 的写法，英文界面用 en-US 的。
  return new Date(value).toLocaleString(getLocale(), { hour12: false })
}

export default function About() {
  const t = useT()
  const [state, setState] = useState<AutoUpdateState>(getAutoUpdateState)

  useEffect(() => {
    return onAutoUpdateChange(setState)
  }, [])

  const { phase, versionInfo, checkedAt, error } = state
  const checking = phase === 'checking'
  const downloading = phase === 'downloading'
  const installing = phase === 'installing'
  const downloaded = phase === 'downloaded'
  const hasUpdate = !!versionInfo?.hasUpdate

  const updateStatusText = (() => {
    if (checking) return t('about.checking')
    if (!versionInfo) return null
    if (versionInfo.error) return t('about.checkFailed')
    if (installing) return t('about.installing')
    // String() 而不是 ?? ''：保持与改造前 `${...}` 完全一致的输出，
    // 这轮只做翻译，不顺手改 latestVersion 为空时的表现。
    if (downloaded) return t('about.downloaded', { version: String(versionInfo.latestVersion) })
    if (downloading) return t('about.downloading', { version: String(versionInfo.latestVersion), percent: Math.round(state.downloadPercent ?? 0) })
    if (hasUpdate) return t('about.updateAvailable', { version: String(versionInfo.latestVersion) })
    return t('about.upToDate')
  })()

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">{t('about.title')}</h1>

      <Card>
        <CardContent className="p-6">
          {/* 品牌 */}
          <div className="flex items-center gap-4">
            <img src={appIcon} alt="SayIt" className="h-16 w-16 rounded-2xl" />
            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}>
                SayIt
              </h2>
              <p className="text-sm text-muted-foreground">{t('about.tagline')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/60">by Liu Qianglong & Claude</p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">v{currentVersion}</span>
                <button
                  type="button"
                  onClick={() => void shellOpen('https://github.com/crosswk/SayIt')}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title="GitHub"
                >
                  <Github className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* 更新 */}
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-medium">{t('about.updateSection')}</h3>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                {updateStatusText && (
                  <p className={`text-sm ${hasUpdate ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {updateStatusText}
                  </p>
                )}
                {error && (
                  <p className="text-xs text-red-500">{error}</p>
                )}
                {checkedAt && (
                  <p className="text-xs text-muted-foreground/60">{t('about.lastChecked', { time: formatTimestamp(checkedAt) })}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* 已下载：显示安装按钮 */}
                {downloaded && !installing && (
                  <Button size="sm" onClick={() => void installNow()}>
                    <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                    {t('about.installNow')}
                  </Button>
                )}
                {/* 有更新但未下载：显示下载按钮 */}
                {hasUpdate && !downloaded && !downloading && !installing && (
                  <Button size="sm" onClick={() => void downloadNow()}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {t('about.downloadUpdate')}
                  </Button>
                )}
                {/* 下载中 */}
                {downloading && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('about.downloadingShort')}
                  </Button>
                )}
                {/* 安装中 */}
                {installing && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('about.installingShort')}
                  </Button>
                )}
                {/* 检查更新按钮 */}
                {!downloading && !installing && !downloaded && (
                  <Button variant="outline" size="sm" onClick={() => void checkAndUpdateNow()} disabled={checking}>
                    {checking ? t('about.checkingShort') : t('about.checkUpdate')}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* 本次更新 */}
          {RELEASE_HIGHLIGHTS.version === currentVersion && RELEASE_HIGHLIGHTS.items.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium">{t('about.releaseNotes', { version: RELEASE_HIGHLIGHTS.version })}</h3>
              <ul className="space-y-1.5">
                {RELEASE_HIGHLIGHTS.items.map((item, index) => (
                  <li key={index} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
