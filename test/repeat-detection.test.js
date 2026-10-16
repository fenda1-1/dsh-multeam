import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bundle } from './support.mjs'

const proto = bundle.TeamScheduler.prototype

const makeScheduler = (overrides = {}) => Object.assign(Object.create(proto), {
	config: {
		repeatDetection: true,
		repeatThreshold: 0.7,
		repeatWindow: 3,
	},
	recentOutputs: new Map(),
	streamBuffers: new Map(),
	repeatNudged: new Map(),
	ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
}, overrides)

// 让 Jaccard 相似的两段文本（>0.7）。
const A = 'The quick brown fox jumps over the lazy dog near the riverbank today'
const B = 'The quick brown fox jumps over the lazy dog near the riverbank today!'
// 明显不同的文本。
const DIFF = 'completely unrelated content about quantum chromodynamics 12345'

// 真实 DSH Session 只有 id，没有 steer——纠偏只能投给 Agent。
const mkSession = (id = 's1') => ({ id })

// 回归 guard：纠偏必须打到 Agent.steer。历史上把 steer 挂在 Session 上，
// 真实运行时（Session 无 steer，也不持有 agent）纠偏恒为静默 no-op。
const mkAgent = (session) => {
	const steered = []
	const cancelled = []
	return {
		session,
		steered,
		cancelled,
		status: 'running',
		steer: (m) => { steered.push(m); return true },
		cancel: (cause, options) => { cancelled.push({ cause, options }); return true },
	}
}

const frame = (type, chunk) => ({ type, ...(chunk !== undefined ? { chunk } : {}) })

// DSH 规范 StreamChunk 的可见文本增量（llm 协议：text-delta / reasoning-delta /
// tool-call-delta / block-start / block-end / usage / finish）。
const textDelta = (text) => ({ type: 'text-delta', index: 0, text })

describe('repeat-output detection (防卡死)', () => {
	it('ngramJaccard: identical = 1, similar > 0.7, different < 0.7', () => {
		const s = makeScheduler()
		assert.strictEqual(s.ngramJaccard(A, A), 1)
		assert.ok(s.ngramJaccard(A, B) > 0.7, `A~B=${s.ngramJaccard(A, B)}`)
		assert.ok(s.ngramJaccard(A, DIFF) < 0.7, `A~DIFF=${s.ngramJaccard(A, DIFF)}`)
		assert.strictEqual(s.ngramJaccard('', ''), 0)
	})

	it('accumulates canonical {type:"text-delta"} chunks and settles on end frame', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		s.observeAssistantStream(agent, frame('start'))
		s.observeAssistantStream(agent, frame('chunk', textDelta('hello ')))
		s.observeAssistantStream(agent, frame('chunk', textDelta('world')))
		s.observeAssistantStream(agent, frame('end'))
		assert.deepStrictEqual(s.recentOutputs.get('s1'), ['hello world'])
		assert.strictEqual(s.streamBuffers.has('s1'), false)
	})

	it('ignores reasoning-delta and tool-call-delta (not visible output)', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		s.observeAssistantStream(agent, frame('start'))
		s.observeAssistantStream(agent, frame('chunk', { type: 'reasoning-delta', index: 0, text: 'internal' }))
		s.observeAssistantStream(agent, frame('chunk', { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: '{}' }))
		s.observeAssistantStream(agent, frame('end'))
		assert.strictEqual(s.recentOutputs.has('s1'), false, '纯推理/工具回合不进入 ring')
	})

	it('ring buffer keeps at most REPEAT_MAX_BUFFER entries', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		for (let i = 0; i < 8; i++) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(`unique-turn-${i}-${'x'.repeat(20)}`)))
			s.observeAssistantStream(agent, frame('end'))
		}
		const buf = s.recentOutputs.get('s1')
		assert.strictEqual(buf.length, 5, 'ring 上限 5')
		assert.ok(buf[0].includes('unique-turn-3'), '最老的被淘汰')
	})

	it('nudges after 3 consecutive similar outputs', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		// 第 1、2 条不触发（window=3）
		for (const t of [A, B]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.steered.length, 0, 'window 未满不纠偏')
		// 第 3 条 → 触发
		s.observeAssistantStream(agent, frame('start'))
		s.observeAssistantStream(agent, frame('chunk', textDelta(A)))
		s.observeAssistantStream(agent, frame('end'))
		assert.strictEqual(agent.steered.length, 1, '连续 3 条相似 → 纠偏一次')
		assert.match(agent.steered[0].content[0].text, /防卡死/u)
	})

	it('one nudge per repeat segment (no storm)', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		for (let i = 0; i < 6; i++) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(A)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.steered.length, 1, '同一重复段只纠偏一次')
	})

	it('resets the nudge flag when a non-similar output breaks the segment', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		for (const t of [A, B, A]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.steered.length, 1)
		// 插入一条不同文本 → 段断裂，标记清除
		s.observeAssistantStream(agent, frame('start'))
		s.observeAssistantStream(agent, frame('chunk', textDelta(DIFF)))
		s.observeAssistantStream(agent, frame('end'))
		assert.strictEqual(s.repeatNudged.has('s1'), false, '段断裂后标记应清除')
		// 再次连续 3 条相似 → 可再次纠偏
		for (const t of [A, B, A]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.steered.length, 2, '新重复段可再次纠偏')
	})

	it('accepts legacy plain-string chunks and bare {text} blocks', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler()
		s.observeAssistantStream(agent, frame('start'))
		s.observeAssistantStream(agent, frame('chunk', 'plain string'))
		s.observeAssistantStream(agent, frame('end'))
		assert.deepStrictEqual(s.recentOutputs.get('s1'), ['plain string'])
	})

	it('hard interrupt cancels the running turn with keepInbox before steering', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler({ config: { repeatDetection: true, repeatThreshold: 0.7, repeatWindow: 3, repeatInterrupt: true } })
		for (const t of [A, B, A]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.cancelled.length, 1, '命中后 cancel 一次')
		assert.deepStrictEqual(agent.cancelled[0].cause, { kind: 'hook', reason: 'repeat-output' })
		assert.deepStrictEqual(agent.cancelled[0].options, { keepInbox: true }, 'keepInbox 保证排队输入不丢')
		assert.strictEqual(agent.steered.length, 1, 'cancel 后紧跟纠偏 steer')
		assert.match(agent.steered[0].content[0].text, /本轮已被强制中断/u, '硬中断措辞必须是「已被中断」而非「请停下」')
	})

	it('soft mode (repeatInterrupt:false) steers without cancelling', () => {
		const agent = mkAgent(mkSession())
		const s = makeScheduler({ config: { repeatDetection: true, repeatThreshold: 0.7, repeatWindow: 3, repeatInterrupt: false } })
		for (const t of [A, B, A]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.cancelled.length, 0, '软提醒不 cancel')
		assert.strictEqual(agent.steered.length, 1, '软提醒仍 steer')
	})

	it('does not cancel an idle agent (cancel on no-activity is a no-op)', () => {
		const agent = mkAgent(mkSession())
		agent.status = 'idle'
		const s = makeScheduler({ config: { repeatDetection: true, repeatThreshold: 0.7, repeatWindow: 3, repeatInterrupt: true } })
		for (const t of [A, B, A]) {
			s.observeAssistantStream(agent, frame('start'))
			s.observeAssistantStream(agent, frame('chunk', textDelta(t)))
			s.observeAssistantStream(agent, frame('end'))
		}
		assert.strictEqual(agent.cancelled.length, 0, 'idle agent 不 cancel')
		assert.strictEqual(agent.steered.length, 1, 'idle agent 仍可被 steer')
	})
})
