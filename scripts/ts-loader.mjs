/**
 * Resolves bundler-style extensionless relative imports (`./types`) to `./types.ts`.
 *
 * The app's imports are written for Next's bundler, which does not need
 * extensions. Node's ESM resolver does. Rather than litter the source with `.ts`
 * suffixes just to make the tests runnable, this hook closes the gap — so
 * `npm test` executes the real engine files, unmodified, with Node's built-in
 * type stripping and no build step and no test framework.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // try the next candidate
      }
    }
  }
  return nextResolve(specifier, context);
}
