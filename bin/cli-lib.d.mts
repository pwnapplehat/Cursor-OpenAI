/** Type declarations for `cli-lib.mjs`, so TypeScript (`test/cliLib.test.ts`) can check usage without this plain-JS CLI helper needing a build step of its own. Keep in sync with the actual implementation. */

export declare const CONFIG_FIELD_TYPES: Readonly<Record<string, "string" | "boolean" | "number">>;

export declare function coerceConfigValue(key: string, rawValue: string): string | number | boolean;

export declare function parseKeyValuePairs(pairs: string[]): Record<string, string | number | boolean>;

export interface ParsedArgv {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export declare function parseArgv(argv: string[]): ParsedArgv;

export declare function resolveBaseUrl(params: { flags: Record<string, string | boolean>; env: Record<string, string | undefined> }): string;

export declare function resolveAdminKey(params: {
  flags: Record<string, string | boolean>;
  env: Record<string, string | undefined>;
  settingsAuthKey: string | undefined;
}): string | undefined;

export declare function stripBom(text: string): string;

export type SseFrame = { done: true } | { done: false; data: unknown };

export declare function parseSseChunk(buffer: string): { frames: SseFrame[]; remainder: string };
