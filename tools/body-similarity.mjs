// Per-method body similarity: for each method name present in both the
// official bundle and the rewrite src, extract the balanced-brace body,
// tokenize (comments and string literals stripped), and report Jaccard.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OFFICIAL = [
	// official npm-published baseline (NOT the locally-patched node_modules copy)
	join(process.env.TEMP ?? 'C:/Users/33385/AppData/Local/Temp', 'official-agent-team/package/lib/index.js'),
]

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) yield* walk(p)
		else if (/\.(ts|tsx)$/.test(name)) yield p
	}
}

// Extract method bodies via a per-name brace-balance scan.
function extractBody(src, name) {
	// method start: line-begin + optional modifiers + name + (args) {
	const re = new RegExp(`(?:^|\\n)[ \\t]*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|get\\s+|set\\s+)*${name}\\s*\\([^()]*\\)\\s*(?::\\s*[^{\\n]+)?\\s*\\{`, 'g')
	let m = re.exec(src)
	if (!m) return null
	const braceAt = src.indexOf('{', re.lastIndex - 1)
	if (braceAt < 0) return null
	let depth = 0, inStr = null, esc = false, j = braceAt
	for (; j < src.length; j++) {
		const c = src[j]
		if (esc) { esc = false; continue }
		if (inStr) {
			if (c === '\\') esc = true
			else if (c === inStr) inStr = null
			continue
		}
		if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
		if (c === '{') depth++
		else if (c === '}') { depth--; if (depth === 0) return src.slice(braceAt, j + 1) }
	}
	return null
}

function tokenize(body) {
	const s = body
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.replace(/'(?:\\.|[^'\\])*'/g, 'STR')
		.replace(/"(?:\\.|[^"\\])*"/g, 'STR')
		.replace(/`(?:\\.|[^`\\])*`/gs, 'STR')
	return s.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[{}()\[\].,;:+\-*/%=<>!&|?^~@#]+/g) ?? []
}

function jaccard(a, b) {
	const sa = new Set(a), sb = new Set(b)
	let inter = 0
	for (const t of sa) if (sb.has(t)) inter++
	return inter / (sa.size + sb.size - inter)
}

const officialSrc = OFFICIAL.map((f) => readFileSync(f, 'utf8')).join('\n')
const names = [...new Set([...officialSrc.matchAll(/(?:^|\n)[ \t]*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([a-zA-Z_$][\w$]*)\s*\([^()]*\)\s*\{/g)].map((m) => m[1]))]
	.filter((n) => !['if','for','while','switch','catch','return','constructor'].includes(n))

const results = []
for (const f of walk('src')) {
	const src = readFileSync(f, 'utf8')
	for (const name of names) {
		const body = extractBody(src, name)
		if (!body || body.length < 80) continue
		const obody = extractBody(officialSrc, name)
		if (!obody) continue
		const s = jaccard(tokenize(body), tokenize(obody))
		if (s >= 0.3) {
			const line = src.slice(0, src.indexOf(body.slice(0, 30))).split('\n').length
			results.push({ file: f, name, line, sim: s })
		}
	}
}
results.sort((a, b) => b.sim - a.sim)
for (const r of results) console.log(`${r.sim.toFixed(2)}  ${r.name}  @${r.file}:${r.line}`)
console.log(`\n${results.length} methods >=0.3 similarity`)
