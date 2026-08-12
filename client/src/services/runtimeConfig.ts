import * as bridge from './bridge'
import { t } from '@/i18n'

declare const __SAYIT_DEFAULT_SERVER_URL__: string

const BUILTIN_DEFAULT_SERVER_URL =
  typeof __SAYIT_DEFAULT_SERVER_URL__ === 'string' && __SAYIT_DEFAULT_SERVER_URL__.trim()
    ? __SAYIT_DEFAULT_SERVER_URL__.trim()
    : 'https://sayitapp.site'

const BACKEND_BASE_URL_STORE_KEY = 'backendBaseUrl'

interface RuntimeEnv {
  VITE_BACKEND_BASE_URL?: string
  VITE_WS_URL?: string
  DEV?: boolean
}

function getEnv(): RuntimeEnv {
  return (import.meta as unknown as { env?: RuntimeEnv }).env || {}
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeUrl(value: string | null | undefined): string {
  return trimSlash(String(value || '').trim())
}

function resolveBuiltinDefaultBaseUrl(): string {
  const env = getEnv()
  const value = normalizeUrl(env.VITE_BACKEND_BASE_URL)
  if (value) return value
  return trimSlash(BUILTIN_DEFAULT_SERVER_URL)
}

function resolveEnvOverrideBaseUrl(): string {
  const env = getEnv()
  return normalizeUrl(env.VITE_BACKEND_BASE_URL)
}

let backendBaseUrl = resolveBuiltinDefaultBaseUrl()

export async function initRuntimeConfig(): Promise<void> {
  // 用户主动保存的地址优先于环境变量
  const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
  const normalized = normalizeUrl(typeof stored === 'string' ? stored : '')
  if (normalized) {
    backendBaseUrl = normalized
    return
  }
  const envOverride = resolveEnvOverrideBaseUrl()
  if (envOverride) {
    backendBaseUrl = envOverride
    return
  }
  backendBaseUrl = resolveBuiltinDefaultBaseUrl()
}

export function getDefaultBackendBaseUrl(): string {
  return resolveBuiltinDefaultBaseUrl()
}

export function getBackendBaseUrl(): string {
  return backendBaseUrl
}

/**
 * 检查更新时用的地址 —— **故意不跟随** getBackendBaseUrl()。
 *
 * 业务后端地址是用户可以改的（服务器模式指向自建服务器）。更新 manifest 如果也跟着改，
 * 这些用户就会去问自己的服务器要更新，拿到 404 后被当成"没配更新"静默返回，
 * 于是永远收不到新版本。更新通道必须固定在官方地址上，和业务后端解耦。
 *
 * 仍然尊重 VITE_BACKEND_BASE_URL：开发时要能把更新通道指到测试服务器上验流程。
 */
export function getUpdateBaseUrl(): string {
  return resolveBuiltinDefaultBaseUrl()
}

export async function setBackendBaseUrl(value: string): Promise<string> {
  const normalized = normalizeUrl(value)
  if (!normalized) {
    throw new Error(t('runtimeConfig.emptyServerUrl'))
  }
  backendBaseUrl = normalized
  await bridge.storeSet(BACKEND_BASE_URL_STORE_KEY, normalized)
  return backendBaseUrl
}

export async function resetBackendBaseUrl(): Promise<string> {
  backendBaseUrl = resolveBuiltinDefaultBaseUrl()
  await bridge.storeDelete(BACKEND_BASE_URL_STORE_KEY)
  return backendBaseUrl
}

export async function getStoredBackendBaseUrl(): Promise<string> {
  const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
  return normalizeUrl(typeof stored === 'string' ? stored : '')
}

export function getWSUrl(): string {
  const env = getEnv()
  const explicit = normalizeUrl(env.VITE_WS_URL)
  if (explicit) return explicit

  const base = getBackendBaseUrl()
  if (base.startsWith('https://')) return `${base.replace(/^https:\/\//, 'wss://')}/ws/transcribe`
  if (base.startsWith('http://')) return `${base.replace(/^http:\/\//, 'ws://')}/ws/transcribe`
  return `${resolveBuiltinDefaultBaseUrl().replace(/^https?:\/\//, 'wss://')}/ws/transcribe`
}
