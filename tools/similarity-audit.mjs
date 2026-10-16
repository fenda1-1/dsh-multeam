// Line-level verbatim-overlap audit: official agent-team bundles vs rewrite src.
// Same methodology as the earlier corpus study: strip comments, trim, drop
// blank lines, keep only lines >= 12 chars, then compute the multiset
// intersection per file and report contiguous verbatim blocks >= 6 lines.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OFFICIAL = [
	'C:/Users/33385/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js',
	'C:/Users/33385/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js',
	'C:/Users/33385/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/index.js',
]

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) yield* walk(p)
		else if (/\.(ts|tsx)$/.test(name)) yield p
	}
}

function normalize(src) {
	// strip block comments and line comments (good enough for source, not for
	// strings containing '//' — acceptable for a coverage estimate)
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '')
	return noBlock.split('\n')
		.map((l) => l.replace(/\/\/.*$/, '').trim())
		.filter((l) => l.length >= 12)
}

function lineMultiset(lines) {
	const m = new Map()
	for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
	return m
}

// Build the official corpus once: multiset of all normalized lines.
const officialLines = []
for (const f of OFFICIAL) {
	try { officialLines.push(...normalize(readFileSync(f, 'utf8'))) }
	catch { /* file may not exist */ }
}
const officialSet = lineMultiset(officialLines)

console.log(`official corpus: ${officialLines.length} normalized lines from ${OFFICIAL.length} files\n`)

const perFile = []
for (const f of walk('src')) {
	const norm = normalize(readFileSync(f, 'utf8'))
	if (norm.length === 0) continue
	// multiset intersection count
	const seen = new Map(officialSet)
	let hit = 0
	for (const l of norm) {
		const n = seen.get(l) ?? 0
		if (n > 0) { seen.set(l, n - 1); hit++ }
	}
	perFile.push({ file: f, total: norm.length, hit, pct: (100 * hit / norm.length).toFixed(1) })
}
perFile.sort((a, b) => b.hit / b.total - a.hit / a.total)
let gt = 0, gh = 0
for (const r of perFile) {
	gt += r.total; gh += r.hit
	if (r.hit > 0) console.log(`${r.pct.padStart(5)}%  ${String(r.hit).padStart(4)}/${String(r.total).padStart(4)}  ${r.file}`)
}
console.log(`\nTOTAL: ${(100 * gh / gt).toFixed(1)}%  ${gh}/${gt} normalized lines`)

// contiguous verbatim blocks in the top files
console.log('\n--- contiguous verbatim blocks (>=6 lines) ---')
const officialLineSet = new Set(officialLines)
for (const r of perFile) {
	if (r.hit === 0) continue
	const src = readFileSync(r.file, 'utf8')
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '')
	const rawLines = noBlock.split('\n')
	let run = []
	const blocks = []
	const flush = () => { if (run.length >= 6) blocks.push(run); run = [] }
	rawLines.forEach((l, i) => {
		const n = l.replace(/\/\/.*$/, '').trim()
		if (n.length >= 12 && officialLineSet.has(n)) run.push(i + 1)
		else flush()
	})
	flush()
	if (blocks.length) {
		console.log(`\n${r.file}:`)
		for (const b of blocks) console.log(`  L${b[0]}-L${b[b.length - 1]} (${b.length} verbatim lines)`)
	}
}
