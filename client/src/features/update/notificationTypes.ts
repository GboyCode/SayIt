import type { Locale } from '@/i18n'

export const UPDATE_NOTIFICATION_EVENT = 'update-notification-state'
export const UPDATE_NOTIFICATION_ACTION = 'update-notification-action'
export const UPDATE_NOTIFICATION_WIDTH = 204

export interface UpdateNotificationData {
  version: string
  currentVersion: string
  theme: string
  locale: Locale
  installing: boolean
  installFailed: boolean
}

export interface UpdateNotificationSnapshot {
  revision: number
  data: UpdateNotificationData | null
}

export interface UpdateNotificationAction {
  action: 'install' | 'later'
  version: string
}
