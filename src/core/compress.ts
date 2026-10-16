/** multeam-compress 的确定性纯函数层：零外部依赖、无 LLM、输出可复现。 */

// 寒暄/复述行起点词表——行首命中且行内无路径/代码/Error 时整行删除。
const GREETING_PATTERN = /^(好的|收到|明白|我来|让我|接下来|首先|然后需要|综上|总结一下|希望这|没问题|好的，|Let me|I'll|Now I|Sure[,!]|Okay|Great)/i
// 路径线索：Windows 盘符、以 / 开头的 token、常见源码/配置文件扩展名。
const PATH_PATTERN = /[A-Za-z]:[\\/]|(?:^|\s)\/[\w.~-]|[^\s"'`(]*\.(?:js|ts|json|yml)\b/i
const ERROR_PATTERN = /Error|error:|报错|失败原因/
const NORMATIVE_PATTERN = /必须|禁止|不要|not |never |only |no /i
// 任务书骨架关键词：目标/验收/边界类条目优先保留。
const BRIEF_KEEP_PATTERN = /目标|验收|边界|约束|必须|禁止|不要|步骤|write_scopes|acceptance|criteria|scope/i
const BULLET_PATTERN = /^\s*(?:[-*•]|\d+[.、)）])/

/** One compression result with before/after token estimates. */
export interface CompressResult {
	readonly text: string
	readonly before: number
	readonly after: number
}

// 逐字保留判定：路径/报错/规约/反引号代码——宁可多保不漏保。
const hasProtectedContent = (line: string): boolean =>
	PATH_PATTERN.test(line) || ERROR_PATTERN.test(line) || NORMATIVE_PATTERN.test(line) || line.includes('`')

/**
 * 粗略 token 估计（约 4 字符 1 token）。
 * @param text - 任意文本。
 * @returns 估计 token 数。
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * 压缩 teammate 汇报：删寒暄复述行、压连续空行；围栏代码块与路径/报错/规约行逐字保留。
 * @param text - 汇报原文。
 * @returns 压缩后文本与压缩前后的估计 token 数。
 */
export function compressReport(text: string): CompressResult {
	const before = estimateTokens(text)
	const out: string[] = []
	let inFence = false
	let pendingBlank = 0
	const flushBlank = (): void => {
		if (pendingBlank > 0 && out.length > 0) out.push('')
		pendingBlank = 0
	}
	for (const line of text.split('\n')) {
		if (line.trimStart().startsWith('```')) {
			flushBlank()
			out.push(line)
			inFence = !inFence
			continue
		}
		if (inFence) {
			out.push(line)
			continue
		}
		if (line.trim() === '') {
			pendingBlank++
			continue
		}
		if (GREETING_PATTERN.test(line) && !hasProtectedContent(line)) continue
		flushBlank()
		out.push(line)
	}
	const result = out.join('\n')
	return { text: result, before, after: estimateTokens(result) }
}

/**
 * 压缩任务书/长描述为骨架：首段 + 关键词行 + bullet + 受保护行，尾部追加压缩标记。
 * @param text - 任务书原文。
 * @param opts - max 为触发压缩的字符阈值，默认 800。
 * @returns 骨架文本与压缩前后的估计 token 数；未超长时原样返回。
 */
export function compressTaskBrief(text: string, opts: { max?: number } = {}): CompressResult {
	const before = estimateTokens(text)
	const max = opts.max ?? 800
	if (text.length <= max) return { text, before, after: before }
	const lines = text.split('\n')
	const keep = new Set<number>()
	// 首段 = 首个空行之前；无空行时只取首行，否则长段等于不压缩。
	const firstBlank = lines.findIndex((line) => line.trim() === '')
	const firstParagraphEnd = firstBlank < 0 ? 1 : firstBlank
	for (let i = 0; i < firstParagraphEnd; i++) keep.add(i)
	let inFence = false
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line.trimStart().startsWith('```')) {
			inFence = !inFence
			keep.add(i)
			continue
		}
		if (inFence || BRIEF_KEEP_PATTERN.test(line) || BULLET_PATTERN.test(line) || hasProtectedContent(line)) keep.add(i)
	}
	const skeleton = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n')
	const result = `${skeleton}\n…[骨架压缩 ${before}→${estimateTokens(skeleton)} tokens]`
	return { text: result, before, after: estimateTokens(result) }
}
