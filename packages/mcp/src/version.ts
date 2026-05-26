/**
 * Package version — injected at build time by vite.config.ts via `define`.
 * Falls back to `'dev'` when running directly via ts-node or tsx.
 */
declare const __VERSION__: string;
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
