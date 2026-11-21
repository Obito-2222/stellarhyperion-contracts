/**
 * Resource limits for the public codecs.
 *
 * Everything in this package reads data somebody else produced: a deployment file an operator
 * committed, a provider's message bytes, a route ladder a UI built. Those are all untrusted for
 * our purposes, and the cost of trusting them is not a wrong answer, it is doing a large amount
 * of work before discovering the input was absurd. A hex string can be megabytes; a JSON file can
 * be a hundred thousand token entries; a ladder can be a million tiers.
 *
 * So every public parser that works in proportion to its input checks an explicit budget first,
 * and refuses with `CodecLimitError` before allocating anything proportional. The budgets below
 * are deliberately generous for real traffic and small enough that a bad input costs nothing:
 *
 * | Limit                     | Default    | What it protects                         |
 * | ------------------------- | ---------- | ---------------------------------------- |
 * | `maxHexBytes`             | 65,536     | `fromHex` and every byte codec built on it |
 * | `maxQuoteTiers`           | 64         | `quoteBatch` amount ladders              |
 * | `maxStrkeyChars`          | 128        | quote planning and note decoding         |
 * | `maxDeploymentJsonChars`  | 2,000,000  | `parseDeploymentSetJson`                 |
 * | `maxDeploymentNetworks`   | 64         | deployment files                         |
 * | `maxDeploymentTokens`     | 256        | tokens per deployment                    |
 * | `maxAssetSymbolChars`     | 32         | asset registry lookups                   |
 * | `maxAssetRegistryEntries` | 512        | the built in asset registry              |
 *
 * A provider extension that genuinely needs more can pass an override to the parser it calls
 * (`fromHex(value, { maxBytes })`, `quoteBatch(tiers, params)` with `params.limits`, or
 * `parseDeploymentSetJson(text, overrides)`), or raise a default with
 * `resolveCodecLimits({ ... })` and pass the result. Raising a limit is a deliberate decision
 * about the largest input the caller is willing to pay to inspect, which is exactly why it is an
 * argument rather than something a document tells you to bump in a constant.
 *
 * Nothing here allocates in proportion to the input, and nothing here depends on Node: the same
 * code runs in a browser bundle.
 */

/** The input budgets every public codec measures against. */
export interface CodecLimits {
  /** Largest byte payload `fromHex` will allocate. */
  readonly maxHexBytes: number;
  /** Largest amount ladder `quoteBatch` will price. */
  readonly maxQuoteTiers: number;
  /** Longest destination string a quote will attempt to parse. */
  readonly maxStrkeyChars: number;
  /** Largest deployment JSON document, measured in characters, before parsing. */
  readonly maxDeploymentJsonChars: number;
  /** Largest number of networks in one deployment set. */
  readonly maxDeploymentNetworks: number;
  /** Largest number of tokens in one network's deployment. */
  readonly maxDeploymentTokens: number;
  /** Longest asset symbol a registry lookup will scan for. */
  readonly maxAssetSymbolChars: number;
  /** Largest built in asset registry the lookup helpers will search. */
  readonly maxAssetRegistryEntries: number;
}

/** The defaults documented above. Frozen so a caller cannot widen them by accident. */
export const DEFAULT_CODEC_LIMITS: CodecLimits = Object.freeze({
  maxHexBytes: 65_536,
  maxQuoteTiers: 64,
  maxStrkeyChars: 128,
  maxDeploymentJsonChars: 2_000_000,
  maxDeploymentNetworks: 64,
  maxDeploymentTokens: 256,
  maxAssetSymbolChars: 32,
  maxAssetRegistryEntries: 512,
});

/** A subset of limits to change, for one call or for a resolved set. */
export type CodecLimitOverrides = Partial<CodecLimits>;

/**
 * Thrown when an input exceeds a budget.
 *
 * Extends `RangeError`, because that is what the rest of this package already throws for a value
 * it will not accept, so callers that only know about `RangeError` keep working. `limit` names
 * the budget, `actual` is the offending size, and `max` is what was allowed, so a log line is
 * enough to tell a truncation bug from an abusive input.
 */
export class CodecLimitError extends RangeError {
  constructor(
    /** The budget that was exceeded, by its `CodecLimits` key. */
    readonly limit: keyof CodecLimits,
    /** The size that was measured. */
    readonly actual: number,
    /** The largest size that budget allows. */
    readonly max: number,
    /** Where in the input the measurement happened, when there is a path to name. */
    readonly path?: string,
  ) {
    const at = path === undefined ? "" : ` at ${path}`;
    super(`${limit} exceeded${at}: ${String(actual)} > ${String(max)}`);
    this.name = "CodecLimitError";
  }
}

/**
 * Merge overrides onto the defaults, checking each one.
 *
 * Refuses a zero, negative, fractional or unsafe override rather than coercing it. A limit that
 * silently became `NaN` would compare false against everything and remove the protection
 * entirely, which is the one failure mode worth being loud about.
 */
export function resolveCodecLimits(overrides: CodecLimitOverrides = {}): CodecLimits {
  const merged: Record<keyof CodecLimits, number> = { ...DEFAULT_CODEC_LIMITS };
  for (const key of Object.keys(DEFAULT_CODEC_LIMITS) as (keyof CodecLimits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        `codec limit ${key} must be a positive safe integer, got ${String(value)}`,
      );
    }
    merged[key] = value;
  }
  return Object.freeze(merged);
}

/** Refuse `actual` when it is over `max`, naming the budget and the path. */
export function assertWithinLimit(
  limit: keyof CodecLimits,
  actual: number,
  max: number,
  path?: string,
): void {
  if (actual > max) throw new CodecLimitError(limit, actual, max, path);
}
