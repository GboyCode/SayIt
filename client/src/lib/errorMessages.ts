/**
 * 把底层异常翻译成用户能据此行动的一句话。
 *
 * 为什么需要这个：设置页原来直接把 `String(error)` 贴到界面上，用户看到的是
 * 「连接失败：TypeError: Failed to fetch」——这句话不区分「网址打错了」「本机没网」
 * 「服务挂了」「被 WAF 拦了」，四种情况的下一步完全不同，用户无从下手。
 *
 * 原始文本不丢弃：`detail` 保留原文给能看懂的人排查，UI 以次要字号展示。
 */

export type ErrorActionHint = 'reset_url' | 'check_key' | 'switch_source' | 'retry' | 'none'

export interface FriendlyError {
  /** 一句话说清发生了什么，以及该往哪个方向查 */
  message: string
  /** 原始异常文本，供排查用；UI 以次要字号展示 */
  detail: string
  /** 建议提供的动作按钮类型，由调用方决定要不要渲染 */
  action: ErrorActionHint
}

function raw(error: unknown): string {
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

/** 从各种异常文本里抠出 HTTP 状态码（`HTTP 401` / `status: 403` / `(404)`） */
function extractHttpStatus(text: string): number | null {
  const match = text.match(/\b(?:HTTP|status(?:\s*code)?\s*[:=]?)\s*(\d{3})\b/i)
    || text.match(/\((\d{3})\)/)
  if (!match) return null
  const code = Number(match[1])
  return code >= 100 && code <= 599 ? code : null
}

function isNetworkFailure(text: string): boolean {
  return /failed to fetch|networkerror|error sending request|econnrefused|enotfound|dns|connection refused|unreachable|websocket 连接失败/i
    .test(text)
}

function isTimeout(text: string): boolean {
  return /timeout|timed out|超时/i.test(text)
}

/**
 * 服务器地址类错误（健康检查、WebSocket 连接）。
 * `hasCustomUrl` 为 true 时才建议「恢复默认地址」——地址本来就是默认值时这个动作没意义。
 */
export function describeServerError(error: unknown, hasCustomUrl: boolean): FriendlyError {
  const text = raw(error)
  const status = extractHttpStatus(text)

  if (isTimeout(text)) {
    return {
      message: '等待服务器响应超时。服务器可能正在启动或负载过高，稍后再试。',
      detail: text,
      action: 'retry',
    }
  }
  if (isNetworkFailure(text)) {
    return {
      message: '连不上这个地址。检查网址有没有写错（含 https:// 前缀）、本机网络是否正常、服务是否已启动。',
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (status === 401 || status === 403) {
    return {
      message: `服务器拒绝了这个请求（HTTP ${status}）。地址能连通，但没有访问权限——确认这是 SayIt 后端，且没有被反向代理或防火墙拦下。`,
      detail: text,
      action: 'retry',
    }
  }
  if (status === 404) {
    return {
      message: '地址能连通，但上面没有 SayIt 服务。这里要填服务的根地址，不要带 /api、/ws 之类的路径。',
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (status && status >= 500) {
    return {
      message: `服务器内部错误（HTTP ${status}）。地址是对的，问题在服务端——查看服务端日志。`,
      detail: text,
      action: 'retry',
    }
  }
  return {
    message: '连接失败。',
    detail: text,
    action: hasCustomUrl ? 'reset_url' : 'retry',
  }
}

/** 云 API 供应商类错误（密钥校验、试拨一次识别） */
export function describeProviderError(error: unknown): FriendlyError {
  const text = raw(error)
  const status = extractHttpStatus(text)

  if (isTimeout(text)) {
    return { message: '等待供应商响应超时，稍后再试。', detail: text, action: 'retry' }
  }
  if (isNetworkFailure(text)) {
    return {
      message: '连不上供应商的服务。检查本机网络，以及是否需要代理才能访问。',
      detail: text,
      action: 'retry',
    }
  }
  if (status === 401 || status === 403 || /invalid.*(key|token)|unauthorized|认证失败|鉴权/i.test(text)) {
    return {
      message: '密钥被拒绝。确认复制完整、没有多余空格，且对应的服务已在供应商控制台开通。',
      detail: text,
      action: 'check_key',
    }
  }
  if (status === 429 || /rate.?limit|quota|欠费|余额/i.test(text)) {
    return {
      message: '被供应商限流或额度不足。检查控制台的余额与调用配额。',
      detail: text,
      action: 'retry',
    }
  }
  if (status === 404 || /model.*not.*(found|exist)/i.test(text)) {
    return {
      message: '供应商说这个模型不存在或未对你开通。换一个供应商，或到控制台申请该模型的权限。',
      detail: text,
      action: 'retry',
    }
  }
  return { message: '连接失败。', detail: text, action: 'retry' }
}

/** 模型下载类错误 */
export function describeDownloadError(error: unknown): FriendlyError {
  const text = raw(error)

  if (isTimeout(text) || isNetworkFailure(text)) {
    return {
      message: '下载中断，没能连上下载源。换一个下载源重试，或走手动下载。',
      detail: text,
      action: 'switch_source',
    }
  }
  if (/no space|磁盘|disk full|not enough space/i.test(text)) {
    return {
      message: '磁盘空间不足，模型没能写完。清理目标磁盘，或在「模型存储位置」换一个盘。',
      detail: text,
      action: 'none',
    }
  }
  if (/permission|denied|access is denied|拒绝访问/i.test(text)) {
    return {
      message: '没有写入权限。检查模型存储目录是否被占用或受保护。',
      detail: text,
      action: 'none',
    }
  }
  if (/checksum|sha256|校验/i.test(text)) {
    return {
      message: '文件校验失败，下载到的内容不完整。换一个下载源重试。',
      detail: text,
      action: 'switch_source',
    }
  }
  return {
    message: '下载失败。换一个下载源重试，或走手动下载。',
    detail: text,
    action: 'switch_source',
  }
}
