// 文本格式规范开关 — 不依赖 AI 的客户端文本处理

import { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import {
  getTextPostProcessOptions,
  saveTextPostProcessOptions,
  DEFAULT_POST_PROCESS,
  type TextPostProcessOptions,
} from '@/services/textPostProcess'

interface ToggleDef {
  key: keyof TextPostProcessOptions
  title: string
  /** 行内可见的简短说明 */
  hint: string
  /** hover 问号显示的详细说明 + 例子（换行用 \n） */
  detail: string
}

const AI_NOTE = '\n\n开启 AI 整理后，排版交给 AI，这一项不生效（避免两边打架）。'

const TOGGLES: ToggleDef[] = [
  {
    key: 'autoSegment',
    title: '智能分段',
    hint: '把一大段语音按语义自动分成多个自然段',
    detail:
      '根据话题转换、句末停顿，把一整段没有换行的识别结果拆成多个自然段，提升可读性。\n\n默认开启。' + AI_NOTE,
  },
  {
    key: 'normalizeNumbers',
    title: '数字规范化',
    hint: '把中文数字改写成阿拉伯数字，如 三点一四 → 3.14、百分之十五 → 15%',
    detail:
      '识别结果里读出来的中文数字，改写成阿拉伯数字，更适合技术、数据类内容。仅在信号明确时转换，尽力而为。\n\n三点一四 → 3.14\n百分之十五 → 15%\nGPT五点四 → GPT 5.4\n扩容二十三台 → 扩容23台\n两百五 → 250\n\n为避免误伤，孤立的「一二三」、成语（十全十美）、逐位读的号码不会转换。' + AI_NOTE,
  },
  {
    key: 'stripTrailingPunctuation',
    title: '去除句末标点',
    hint: '只删掉每段结尾的标点，句子中间的标点保留，如「你好，世界。」→「你好，世界」',
    detail:
      '只去掉每一段结尾处的标点符号，句子中间的标点（逗号、顿号等）保持不变。适合把识别结果直接发到聊天框、不想带句末句号的场景。\n\n有多段（换行）时，每一段的结尾都会处理，不只是最后一段。\n\n你好，世界。→ 你好，世界\n真的吗？！→ 真的吗\n第一段。↵第二段！→ 第一段↵第二段' + AI_NOTE,
  },
  {
    key: 'punctuationToSpace',
    title: '标点替换为空格',
    hint: '把所有标点都换成空格，让内容以空格分隔，如「你好，世界！」→「你好 世界」',
    detail:
      '把文本里的所有标点符号都替换成空格，并合并多余空格、去掉首尾空格。适合当作关键词、搜索词，或粘贴到不希望带标点的地方。数字里的小数点和百分号会保留。\n\n你好，世界！→ 你好 世界\n第一，先做A；第二，再做B。→ 第一 先做A 第二 再做B\n准确率是99.5%。→ 准确率是99.5%' + AI_NOTE,
  },
]

export default function TextFormatSection() {
  const [opts, setOpts] = useState<TextPostProcessOptions>(DEFAULT_POST_PROCESS)
  const initialized = useRef(false)
  // 读到已保存值之前，开关先隐藏、且不放动画：避免先画出默认值再跳到已保存值（闪一下）。
  // 用 finally 兜底，读取失败也让开关出现（呈默认值），不至于一直隐藏。
  const [ready, setReady] = useState(false)
  // animate 与 ready 分开：ready 决定何时显示，animate 决定何时允许过渡。
  // 若在揭开/赋值的同一帧就把 transition 加回来，按 CSS 规范浏览器会认为
  // 「有过渡且值变了」，于是把「默认值→已保存值」真的动画一遍（看起来就是闪一下）。
  // 所以揭开那一帧仍不带过渡，隔两帧待值稳定后才开过渡。
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    getTextPostProcessOptions()
      .then((loaded) => {
        setOpts(loaded)
        initialized.current = true
      })
      .finally(() => {
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
      })
  }, [])

  useEffect(() => {
    if (!initialized.current) return
    void saveTextPostProcessOptions(opts)
  }, [opts])

  const toggle = (key: keyof TextPostProcessOptions) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="mb-6 rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold">格式规范</h2>
        {/* 说清生效条件：这几项是"没有 AI 时我们自己做的排版兜底"。开了 AI 整理，
            排版就归 AI 管，这里整体不生效——两边都做会互相打架。文本替换不在此列，见热词页的「文本替换」。 */}
        <p className="mt-0.5 text-xs text-muted-foreground">
          仅在关闭 AI 整理的极速模式下生效；开启 AI 整理后，排版交给 AI。
        </p>
      </div>
      <div className="divide-y divide-border/60">
        {TOGGLES.map((t) => (
          <div key={t.key} className="flex items-center gap-2.5 px-4 py-2.5">
            <Switch
              checked={opts[t.key]}
              onChange={() => toggle(t.key)}
              size="sm"
              noAnimation={!animate}
              hidden={!ready}
              className="shrink-0"
            />
            <span className="shrink-0 text-sm font-medium">{t.title}</span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate text-xs text-muted-foreground">{t.hint}</span>
              <Tooltip content={t.detail} variant="light">
                <HelpCircle className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 hover:text-muted-foreground" />
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
