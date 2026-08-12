import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { UpdateStatus } from '@/types/update'
import { t } from '@/i18n'
import { useLocale } from '@/i18n/useT'

interface UpdateNoticeProps {
  updateStatus: UpdateStatus
  onInstallUpdate: () => void
}

function isVisiblePhase(phase: UpdateStatus['phase']) {
  return phase === 'available' || phase === 'downloading' || phase === 'downloaded' || phase === 'installing'
}

export default function UpdateNotice({ updateStatus, onInstallUpdate }: UpdateNoticeProps) {
  const locale = useLocale()
  const [visible, setVisible] = useState(false)

  const noticeKey = `${updateStatus.phase}:${updateStatus.nextVersion || updateStatus.currentVersion}`

  useEffect(() => {
    setVisible(isVisiblePhase(updateStatus.phase))
  }, [noticeKey, updateStatus.phase])

  const content = useMemo(() => {
    const version = updateStatus.nextVersion || ''
    switch (updateStatus.phase) {
      case 'available':
        return {
          title: t('update.availableTitle', { version }),
          description: t('update.availableDesc'),
        }
      case 'downloading':
        return {
          title: t('update.downloadingTitle', { version }),
          description: t('update.downloadingDesc'),
        }
      case 'downloaded':
        return {
          title: t('update.downloadedTitle', { version }),
          description: t('update.downloadedDesc'),
        }
      case 'installing':
        return {
          title: t('update.installingTitle', { version }),
          description: t('update.installingDesc'),
        }
      default:
        return null
    }
  }, [updateStatus.phase, updateStatus.nextVersion, locale])

  if (!visible || !content) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">{content.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{content.description}</p>
          {typeof updateStatus.progressPercent === 'number' ? (
            <div className="pt-2">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('update.progress')}</span>
                <span>{updateStatus.progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground transition-all"
                  style={{ width: `${updateStatus.progressPercent}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          {updateStatus.phase === 'downloaded' ? (
            <>
              <Button variant="outline" onClick={() => setVisible(false)}>
                {t('update.later')}
              </Button>
              <Button onClick={onInstallUpdate}>
                {t('update.installNow')}
              </Button>
            </>
          ) : updateStatus.phase === 'installing' ? null : (
            <Button variant="outline" onClick={() => setVisible(false)}>
              {t('update.dismiss')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
