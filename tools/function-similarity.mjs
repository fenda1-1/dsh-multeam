// Function-level similarity: map every function/method in rewrite src to the
// best-matching function in the official bundles, using normalized-token
// Jaccard on function bodies. This catches "ported verbatim then lightly
// edited" that line-level multiset misses.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OFFICIAL = [
	'C:/Users/33385/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js',
	'C:/Users/33385/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js',
]

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) yield* walk(p)
		else if (/\.(ts|tsx|js)$/.test(name)) yield p
	}
}

// crude function extractor: split on top-level-ish function/method boundaries.
// Works well enough for bundled JS (methods are `name(...) {`) and our TS.
function extractFunctions(src, file) {
	const fns = []
	// match: optional modifiers + name + ( params ) { — also arrow funcs and
	// `const name = (...) => {` and class methods
	// match three shapes:
	//   1. function declarations:    function name(a,b) { / export async function name(
	//   2. class/object methods:     name(a,b) { / async name( / static name( / get name()
	//   3. arrow consts:             const name = (a,b) => { / const name = async (a,b) => {
	// The capture is the identifier; we then brace-balance forward.
	const re = /(?:^|\n|;|{)([ \t]*)(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\(([^()]*)\)\s*(?::\s*[^{\n]+)?\s*(?:\{|=>)/g
	let m
	while ((m = re.exec(src))) {
		const start = m.index
		// find body start: the '{' after the match, or after '=>'
		let i = re.lastIndex
		while (i < src.length && src[i] !== '{') {
			if (src[i] === ';' || src[i] === '\n' && src[i - 1] === ';') break
			i++
		}
		if (src[i] !== '{') continue
		// balance braces
		let depth = 0, j = i, inStr = null, esc = false, inTpl = false, tplDepth = 0
		for (; j < src.length; j++) {
			const c = src[j]
			if (esc) { esc = false; continue }
			if (inStr) {
				if (c === '\\') esc = true
				else if (c === inStr) inStr = null
				continue
			}
			if (inTpl) {
				if (c === '\\') esc = true
				else if (c === '`') inTpl = false
				else if (c === '$' && src[j + 1] === '{') { tplDepth++; j++ }
				else if (c === '}' && tplDepth > 0) tplDepth--
				else if (c === '}' && tplDepth === 0) inTpl = false
				continue
			}
			if (c === '"' || c === "'") { inStr = c; continue }
			if (c === '`') { inTpl = true; tplDepth = 0; continue }
			if (c === '{') depth++
			else if (c === '}') { depth--; if (depth === 0) break }
		}
		const body = src.slice(i, j + 1)
		const name = m[2]
		if (['if','for','while','switch','catch','return','new','else','function','class','do','try'].includes(name)) continue
		if (body.length < 80) continue
		const line = src.slice(0, start).split('\n').length
		fns.push({ file, name, line, body })
		re.lastIndex = j + 1
	}
	return fns
}

function tokenize(body) {
	// strip comments, collapse identifiers to generic token shape to make the
	// comparison structure-based rather than name-based
	const s = body
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.replace(/'(?:\\.|[^'\\])*'/g, 'STR')
		.replace(/"(?:\\.|[^"\\])*"/g, 'STR')
		.replace(/`(?:\\.|[^`\\])*`/gs, 'STR')
	const toks = s.match(/[A-Za-z_$][\w$]*|[{}()\[\].,;:+\-*/%=<>!&|?^~@#]+|\d+(?:\.\d+)?/g) ?? []
	return toks
}

function jaccard(a, b) {
	const sa = new Set(a), sb = new Set(b)
	let inter = 0
	for (const t of sa) if (sb.has(t)) inter++
	return inter / (sa.size + sb.size - inter)
}

const officialFns = []
for (const f of OFFICIAL) officialFns.push(...extractFunctions(readFileSync(f, 'utf8'), f))
for (const f of officialFns) f.toks = tokenize(f.body)
console.log(`official functions: ${officialFns.length}\n`)

const results = []
for (const f of walk('src')) {
	const fns = extractFunctions(readFileSync(f, 'utf8'), f)
	for (const fn of fns) {
		fn.toks = tokenize(fn.body)
		let best = 0, bestFn = null
		for (const ofn of officialFns) {
			const s = jaccard(fn.toks, ofn.toks)
			if (s > best) { best = s; bestFn = ofn }
		}
		if (best >= 0.5) results.push({ file: fn.file, name: fn.name, line: fn.line, sim: best.toFixed(2), match: bestFn.name, matchFile: bestFn.file.split('/').pop(), matchLen: bestFn.body.length, len: fn.body.length })
	}
}
results.sort((a, b) => parseFloat(b.sim) - parseFloat(a.sim))
for (const r of results) {
	console.log(`${r.sim}  ${r.name}  @${r.file}:${r.line}  ~ ${r.match}(${r.matchFile})`)
}
console.log(`\n${results.length} functions with >=50% structural similarity to official code`)
