/**
 * The version reported by `dhb --version`.
 *
 * Kept as a standalone module so it can be imported without pulling in the
 * Commander program or any command runtime, and so the build does not depend
 * on JSON import assertions for `package.json`.
 */
export const VERSION = "0.1.0";
