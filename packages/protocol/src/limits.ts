/**
 * How much external input a parser will look at before doing work proportional to it.
 *
 * Every parser in this package reads something nobody in this repository produced at runtime: a
 * rail payload, a persisted quote snapshot, a deployment file, a provider override document, an
 * amount ladder from an input field. None of them can trust its length, and a decoder that
 * allocates first and checks second turns a six megabyte string into a six megabyte allocation
 * before discovering it was never a note. In a browser tab that is the failure people notice.
 *
 * So the budgets live in one table, with defaults taken from the wire formats rather than from
 * what felt generous:
 *
 * - A note is 29 bytes, a CCTP hook 34 or 42, a word 32. `maxMessageBytes` sits far above any
 *   Hyperion message so a provider extension with a larger payload still parses, and far below
 *   anything whose rejection would itself be expensive.
 * - A ladder is one tier per amount a person might type, multiplied by the rail count, so
 *   `maxQuoteTiers` bounds the product rather than the input alone.
 * - Deployment sets and provider override documents are small, hand reviewed JSON. Their counts
 *   are bounded so a malformed or hostile document fails on shape instead of on size.
 *
 * Exceeding a budget throws `InputBudgetError` before the input is decoded, sliced or expanded,
 * which is the only useful ordering: the rejection has to be cheaper than the work it prevents.
 * Every function that takes a budget accepts overrides as its last argument, so a provider that
 * really does carry larger payloads says so once, explicitly, at the call site rather than this
 * package guessing what "large enough" means for somebody else's rail.
 */

/** The size ceilings a bounded parser enforces. Every value is a positive safe integer. */
export interface InputBudgets {
  /** Largest message payload a byte parser will decode, in bytes. */
  readonly maxMessageBytes: number;
  /** Largest amount ladder a batch planner will price in one call, in tiers. */
  readonly maxQuoteTiers: number;
  /** Largest number of dated snapshots one comparison will consider. */
  readonly maxSnapshots: number;
  /** Largest serialized quote snapshot accepted, in UTF-16 characters. */
  readonly maxQuoteSnapshotChars: number;
  /** Largest number of networks in one deployment set. */
  readonly maxDeploymentNetworks: number;
  /** Largest number of token records in one deployment. */
  readonly maxDeploymentTokens: number;
  /** Largest number of rail slugs in one token record. */
  readonly maxDeploymentRoutes: number;
  /** Largest number of wasm hash entries in one Stellar deployment. */
  readonly maxDeploymentWasmHashes: number;
  /** Largest number of chains one provider override document may name. */
  readonly maxProviderChains: number;
  /** Largest number of asset symbols per chain in a provider override document. */
  readonly maxProviderSymbols: number;
}

/** Per-call overrides. A budget left out keeps its default. */
export type InputBudgetOverrides = Partial<InputBudgets>;

/**
 * The published defaults.
 *
 * Frozen because a parser that mutates the shared table would change the limits of every other
 * caller in the same process, which is the sort of global state that only shows up as a mystery
 * in somebody else's bundle.
 */
export const INPUT_BUDGETS: InputBudgets = Object.freeze({
  maxMessageBytes: 4_096,
  maxQuoteTiers: 256,
  maxSnapshots: 256,
  maxQuoteSnapshotChars: 1_048_576,
  maxDeploymentNetworks: 32,
  maxDeploymentTokens: 256,
  maxDeploymentRoutes: 16,
  maxDeploymentWasmHashes: 64,
  maxProviderChains: 32,
  maxProviderSymbols: 128,
});

/** Every budget name, so an override cannot silently misspell its way into being ignored. */
export const INPUT_BUDGET_NAMES: readonly (keyof InputBudgets)[] = Object.freeze(
  Object.keys(INPUT_BUDGETS) as (keyof InputBudgets)[],
);

/**
 * Thrown when external input exceeds a budget, before anything proportional to it happens.
 *
 * Deliberately not a `HyperionProtocolError`: no contract returns this and no chain has an error
 * tag for it. It describes a local parser refusing a local caller, and carrying the budget name,
 * the ceiling and the observed size means a caller can log the one number that changed.
 */
export class InputBudgetError extends Error {
  constructor(
    readonly path: string,
    readonly budget: keyof InputBudgets,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`input exceeds ${budget} at ${path}: ${String(actual)} > ${String(limit)}`);
    this.name = "InputBudgetError";
  }
}

/** Merge overrides over the defaults, refusing unknown names and meaningless ceilings. */
export function resolveInputBudgets(overrides: InputBudgetOverrides = {}): InputBudgets {
  const entries = Object.entries(overrides);
  if (entries.length === 0) return INPUT_BUDGETS;
  const resolved: Record<string, number> = { ...INPUT_BUDGETS };
  for (const [name, value] of entries) {
    if (!INPUT_BUDGET_NAMES.includes(name as keyof InputBudgets)) {
      throw new TypeError(`${name} is not an input budget`);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`input budget ${name} must be a positive safe integer`);
    }
    resolved[name] = value;
  }
  return Object.freeze(resolved as unknown as InputBudgets);
}

/** Refuse `actual` when it is past `budget`, naming the field that was too large. */
export function assertInputBudget(
  actual: number,
  budget: keyof InputBudgets,
  path: string,
  limits: InputBudgets = INPUT_BUDGETS,
): void {
  const limit = limits[budget];
  if (actual > limit) throw new InputBudgetError(path, budget, limit, actual);
}

/** Byte count of a payload, without decoding a hex string. */
export function messageByteLength(payload: Uint8Array | string): number {
  // Two characters per byte, and the over-count when a "0x" prefix is present only makes the check
  // more conservative. Measuring a string's length costs nothing; parsing it does not.
  return typeof payload === "string" ? Math.ceil(payload.length / 2) : payload.length;
}

/** Refuse a message payload over `maxMessageBytes` before `fromHex` allocates its bytes. */
export function assertMessageBudget(
  payload: Uint8Array | string,
  path: string,
  limits: InputBudgets = INPUT_BUDGETS,
): void {
  assertInputBudget(messageByteLength(payload), "maxMessageBytes", path, limits);
}
