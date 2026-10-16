import { defineConfig } from 'tsdown'

const CLIENT_ID = 'dsh-multeam/client'

export default defineConfig([
	// Host bundle: core + tools + scheduler aggregated behind one ESM entry.
	// Bundled into a single file on purpose — tsdown's unbundle mode lowers
	// `export { ... } from './x.js'` to a bare side-effect import, which would
	// silently drop re-exported bindings from the published surface.
	{
		entry: ['src/index.ts'],
		format: ['esm'],
		outDir: 'dist',
		platform: 'node',
		dts: true,
		clean: true,
		outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
		// This is a library entry, not an app: tree-shaking would drop unused
		// public re-exports.
		treeshake: false,
		deps: { neverBundle: [/^@deepseek-ai\//, 'zod', '@deepseek-ai/schemastery'] },
	},
	// Browser bundle: web team board. Kept CJS inside the ModuleLoader factory
	// because DSH resolves `require` through its own loader. Bundled into one
	// file — the ModuleLoader factory must be self-contained.
	{
		entry: ['src/client/index.ts'],
		format: ['cjs'],
		outDir: 'dist',
		platform: 'browser',
		dts: false,
		clean: false,
		outExtensions: () => ({ js: '.js' }),
		deps: {
			neverBundle: ['react', 'react/jsx-runtime', 'react-dom', /^@deepseek-ai\//],
		},
		outputOptions: {
			entryFileNames: 'client.js',
			banner: `window.__ModuleLoader__.load({
	id: "${CLIENT_ID}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/* cordis unwrapExports follows \`default\` when __esModule is set, which
		 * would reduce the plugin surface to a lone apply function and drop the
		 * \`inject\` declaration. The verified old bundle carries only toStringTag. */
		Object.defineProperty(exports, "__esModule", { value: true });
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
			footer: `		return module.exports;
	}
});`,
		},
	},
])
