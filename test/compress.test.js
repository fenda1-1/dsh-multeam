import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bundle } from './support.mjs'

const { compressReport, compressTaskBrief, estimateTokens } = bundle
const schedProto = bundle.TeamScheduler.prototype

const makeScheduler = (overrides = {}) => {
	const sched = Object.assign(Object.create(schedProto), {
		config: { compressInject: true, compressBriefMax: 200 },
		compressSaved: 0,
		compressSamples: 0,
		perfMap: new Map(),
		perfLoaded: new Map(),
		perfDirty: new Map(),
		inProgressSince: new Map(),
		timeoutNotified: new Map(),
		retryCount: new Map(),
		retryExhausted: new Map(),
		retryLastError: new Map(),
		notified: new Map(),
		lastSeenRevision: new Map(),
		lastDecayAt: new Map(),
		dispatchFailures: new Map(),
		failureWarned: new Set(),
		decisionLog: new Map(),
		alertLog: [],
		stats: new Map(),
		stallTrack: new Map(),
		coalescePending: new Map(),
		lessonsByTag: new Map(),
		lessonSeen: new Set(),
	}, overrides)
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get(id) { return overrides.agents?.[id] ?? undefined } },
		sessionProjections: overrides.sessionProjections,
	}
	return sched
}

// ── estimateTokens ──────────────────────────────────────────────────────────
describe('estimateTokens', () => {
	it('empty string → 0', () => {
		assert.strictEqual(estimateTokens(''), 0)
	})
	it('4 chars → 1 token', () => {
		assert.strictEqual(estimateTokens('abcd'), 1)
	})
	it('200 chars → 50 tokens', () => {
		assert.strictEqual(estimateTokens('x'.repeat(200)), 50)
	})
})

// ── compressReport ──────────────────────────────────────────────────────────
describe('compressReport', () => {
	it('drops greeting lines', () => {
		const input = '好的，我完成了。\nLet me check the logs.\n改动已落盘。'
		const r = compressReport(input)
		assert.ok(!r.text.includes('好的，我完成了'), '寒暄行应被删除')
		assert.ok(!r.text.includes('Let me check'), '英文寒暄行应被删除')
		assert.ok(r.text.includes('改动已落盘'), '实质行保留')
	})
	it('keeps greeting lines that carry a path', () => {
		const input = '好的，改了 E:\\x\\y.js 这个文件\n收到，马上处理'
		const r = compressReport(input)
		assert.ok(r.text.includes('E:\\x\\y.js'), '含路径的寒暄行应保留')
		assert.ok(!r.text.includes('收到，马上处理'), '纯寒暄行仍被删')
	})
	it('preserves fenced code blocks verbatim', () => {
		const code = '```js\nconst a = 1;\n好的，不要动这里\n```'
		const r = compressReport(`好的，开始。\n${code}\n收尾。`)
		assert.ok(r.text.includes(code), '代码块逐字保留')
	})
	it('keeps lines with Error:/必须/禁止', () => {
		const input = 'TypeError: boom\n必须重启服务\n禁止改动 prod\n普通叙述行会被压缩判断处理'
		const r = compressReport(input)
		assert.ok(r.text.includes('TypeError: boom'), 'Error 行保留')
		assert.ok(r.text.includes('必须重启服务'), '必须 行保留')
		assert.ok(r.text.includes('禁止改动 prod'), '禁止 行保留')
	})
	it('collapses consecutive blank lines to one', () => {
		const input = '第一行\n\n\n\n\n第二行'
		const r = compressReport(input)
		assert.ok(!r.text.includes('\n\n\n'), '连续空行压成 1')
		assert.ok(r.text.includes('第一行\n\n第二行') || r.text.includes('第一行\n第二行'))
	})
	it('before/after numeric and after <= before', () => {
		const input = '好的，我完成了。\n\n\n实质内容行。\nLet me check.'
		const r = compressReport(input)
		assert.strictEqual(r.before, estimateTokens(input))
		assert.strictEqual(r.after, estimateTokens(r.text))
		assert.ok(r.after <= r.before, `after(${r.after}) <= before(${r.before})`)
	})
})

// ── compressTaskBrief ───────────────────────────────────────────────────────
describe('compressTaskBrief', () => {
	it('returns text unchanged when <= max', () => {
		const text = '短任务书，直接执行。'
		const r = compressTaskBrief(text, { max: 800 })
		assert.strictEqual(r.text, text)
		assert.strictEqual(r.before, r.after, 'before === after')
	})
	it('compresses long description to skeleton with marker', () => {
		const narrative = '这一段只是背景叙述，没有任何关键词，讲了很长很长的故事来解释来龙去脉。'
		const text = [
			'任务目标：实现压缩子系统并接入调度器注入点。',
			'',
			narrative,
			narrative,
			'验收标准：npm run check 全绿',
			'必须保持向后兼容',
			'- 第一步：实现纯函数',
			'- 第二步：接入注入点',
			narrative,
			narrative,
		].join('\n')
		const r = compressTaskBrief(text, { max: 200 })
		assert.ok(r.text.length < text.length, '骨架应短于原文')
		assert.ok(r.text.includes('…[骨架压缩'), '尾部有压缩标记')
		assert.ok(r.text.includes('验收标准'), '验收标准行保留')
		assert.ok(r.text.includes('必须保持向后兼容'), '必须 行保留')
		assert.ok(r.text.includes('- 第一步'), 'bullet 行保留')
		assert.ok(r.text.includes('任务目标'), '首段保留')
		assert.ok(!r.text.includes(narrative), '纯叙述行被删')
		assert.ok(r.after <= r.before)
	})
	it('keeps 禁止 lines under compression', () => {
		const text = `任务目标：x。\n\n${'叙述行填充。'.repeat(60)}\n禁止修改 package.json\n${'更多叙述填充。'.repeat(60)}`
		const r = compressTaskBrief(text, { max: 200 })
		assert.ok(r.text.includes('禁止修改 package.json'), '禁止 行在任何情况下保留')
	})
})

// ── scheduler 集成：briefText + NOTIFY 注入 ─────────────────────────────────
describe('scheduler briefText / compressInject', () => {
	const LONG_DESC = `任务目标：构造超长描述触发压缩。\n\n${'这是填充用的叙述句，不含任何关键词，会被骨架删除。'.repeat(60)}\n必须保留这一行。`

	it('briefText returns skeleton when description exceeds compressBriefMax', () => {
		const sched = makeScheduler()
		const frag = sched.briefText({ id: 'task-1', description: LONG_DESC })
		assert.ok(frag.startsWith('\n任务骨架：'), '返回片段带「任务骨架：」前缀')
		assert.ok(frag.includes('必须保留这一行'), '受保护行进入骨架')
		assert.ok(!frag.includes('填充用的叙述句'), '被删的叙述句不进骨架')
		assert.ok(sched.compressSaved > 0, `compressSaved>0, got ${sched.compressSaved}`)
		assert.strictEqual(sched.compressSamples, 1)
	})

	it('briefText returns empty when compressInject off or under threshold', () => {
		const off = makeScheduler({ config: { compressInject: false, compressBriefMax: 200 } })
		assert.strictEqual(off.briefText({ id: 't', description: LONG_DESC }), '')
		const short = makeScheduler()
		assert.strictEqual(short.briefText({ id: 't', description: '短描述' }), '')
		assert.strictEqual(short.compressSaved, 0, '未触发压缩不计量')
	})

	it('runPass NOTIFY message embeds skeleton and counts compressSaved', async () => {
		const sent = []
		const sched = makeScheduler({
			agents: { 'lead-1': { steer() {} } },
			sessionProjections: {
				stateOf() {
					return {
						id: 'lead-1', failure: undefined,
						members: [{ id: 'alice-1', name: 'alice', phase: 'active', description: 'impl' }],
						tasks: [{
							id: 'task-1', ownerId: 'alice-1', status: 'in_progress',
							subject: '压缩集成', description: LONG_DESC, blockedBy: [], revision: 1,
						}],
					}
				},
			},
		})
		sched.ctx.agentTeams = {
			async sendMessage(agent, envelope) {
				sent.push({ target: envelope.target, text: envelope.content?.[0]?.text ?? '' })
			},
		}
		await sched.runPass({ id: 'lead-1' })
		assert.strictEqual(sent.length, 1, 'one NOTIFY message dispatched')
		assert.ok(sent[0].text.includes('任务骨架：'), 'NOTIFY 含「任务骨架：」前缀')
		assert.ok(sent[0].text.includes('必须保留这一行'), '骨架受保护行在 NOTIFY 中')
		assert.ok(!sent[0].text.includes('填充用的叙述句'), '被删叙述句不在 NOTIFY 中')
		assert.ok(sched.compressSaved > 0, `compressSaved>0, got ${sched.compressSaved}`)
	})
})
