import type { NextConfig } from "next";

/**
 * Deliberately minimal.
 *
 * `node:sqlite` needs no configuration here: the `node:` prefix marks it as a
 * built-in, so the bundler externalises it automatically. It is only ever
 * imported from `lib/db.ts`, which is reached exclusively from Server
 * Components, Server Actions, and route handlers — if it ever appears in a
 * client bundle, the offending file is importing `lib/db` or `lib/queries`
 * across the boundary, and that is the bug to fix rather than a thing to
 * configure around.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
