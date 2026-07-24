// 本次版本更新亮点（关于页面展示）。
// 每次发版时更新 version 与 items，保持与 CHANGELOG 同步。
// version 需与打包版本一致，关于页面仅在与当前版本匹配时展示，避免串版。
//
// 每条写成一句话：前半句说明功能，后半句补充解释，读起来更顺。

export interface ReleaseHighlights {
  version: string
  items: string[]
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = {
  version: '0.1.2',
  items: [
    '修复长时间后台运行后偶发「一直处理中、超时无结果」的问题：后台连接更稳定，不再被误判空闲而断开',
    '识别超时不再丢录音：即使这次超时没结果，录音也会保存到历史，可随时「重新识别」',
  ],
}
