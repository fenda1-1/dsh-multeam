/**
 * Test support: resolve the built host bundle under Node ESM.
 *
 * The package's own `dist/index.js` is what npm publishes, so tests import the
 * built output rather than the TypeScript sources — this also catches build
 * breakage. The host bundle is intentionally a single file, so core, scheduler,
 * and tools are all reachable from it.
 */
const host = await import(new URL('../dist/index.js', import.meta.url).href)

export const dist = new URL('../dist/', import.meta.url)

/** The built host bundle (core + tools + scheduler). */
export const bundle = host

/** Import one built module by its dist-relative path. */
export async function load(rel) {
	return await import(new URL(rel, dist).href)
}
