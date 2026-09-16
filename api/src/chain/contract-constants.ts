/**
 * Checks the API's mirrored Solidity constants against the compiled artifacts.
 *
 * BE-29 scope 8. `chain/theme-policy.ts` restates numbers that live in the
 * bytecode of `ThemeFactory`, `KeylessVault` and `FeeController`, and
 * `routers/theme.ts` encodes them straight into `deployTheme` calldata. The
 * vault that call deploys is immutable and has no rescue function, so a mirror
 * that has drifted is not a stale comment: it is either a transaction the
 * factory reverts, or a permanently wrong policy the factory accepts.
 *
 * ## Why this reads the source, and why that is still the artifact
 *
 * Foundry's `out/<file>/<name>.json` carries the ABI, the bytecode and the
 * compiler metadata. It does not carry constant VALUES in any directly readable
 * field: `uint256 public constant MAX_FEE_BPS = 100` compiles to a getter whose
 * literal is buried in the dispatch, and this repo's build-info is the trimmed
 * variant with no AST. Executing the getter is not an option either, since
 * nothing is deployed on 46630 yet (`contracts/deployments/46630.json` is all
 * nulls) and there is no local EVM in the API's dependency tree.
 *
 * So the chain of evidence is built out of what the artifact does carry:
 *
 * 1. The artifact's `metadata.sources[path].keccak256` is the hash solc recorded
 *    for the exact source text it compiled. Hashing `contracts/src/*.sol` off
 *    disk and comparing proves the source being read IS the compiled source. A
 *    source edited after the last `forge build` fails here rather than passing
 *    on a stale artifact.
 * 2. The artifact's ABI must expose the constant as a `view` getter returning
 *    `uint256`. A renamed or removed constant fails here.
 * 3. Only then is the value parsed out of the hash-verified source and compared
 *    against the mirror.
 *
 * Step 1 is what makes step 3 a claim about the compiled contract rather than
 * about a file someone might have touched since.
 *
 * ## Why this is a script and not a startup assertion
 *
 * `contracts/out` is a build artifact and is gitignored, so it does not exist in
 * the API container. Failing startup on a missing artifact would make the API
 * refuse to boot in production for a check that can only run where Foundry ran.
 * `bun run contracts:check` is the same shape as `bun run chain:check`, which
 * checks chain wiring against a live RPC for the same reason.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keccak256, toHex } from "viem";

import { themeFactoryAbi } from "./abis/index.ts";
import {
  BAND_HEADROOM_BPS,
  BPS,
  DEVIATION_THRESHOLD_BPS,
  MAX_FEE_BPS,
  MAX_SLIPPAGE_BPS,
  PROTOCOL_CUT_BPS,
  SLIPPAGE_CAP_BPS,
} from "./theme-policy.ts";

const CONTRACTS_ROOT = fileURLToPath(new URL("../../../contracts/", import.meta.url));

/** One assertion and what it found. `ok: false` is a bug, never a warning. */
export interface ConstantCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** Raised when the artifacts are not on disk at all, which is not a failure of
 *  the check: it means `forge build` has not run in this checkout. */
export class ArtifactsUnavailableError extends Error {}

interface Artifact {
  abi: {
    type: string;
    name?: string;
    stateMutability?: string;
    inputs?: unknown[];
    outputs?: unknown[];
  }[];
  metadata: { sources: Record<string, { keccak256?: string }> };
}

/** Contract name -> its artifact path and its source path, both relative to
 *  `contracts/`. Source paths are exactly the keys solc uses in the metadata. */
const CONTRACTS = {
  ThemeFactory: {
    artifact: "out/ThemeFactory.sol/ThemeFactory.json",
    source: "src/ThemeFactory.sol",
  },
  KeylessVault: {
    artifact: "out/KeylessVault.sol/KeylessVault.json",
    source: "src/KeylessVault.sol",
  },
  FeeController: {
    artifact: "out/FeeController.sol/FeeController.json",
    source: "src/FeeController.sol",
  },
} as const;

type ContractName = keyof typeof CONTRACTS;

interface VerifiedContract {
  name: ContractName;
  artifact: Artifact;
  /** The source text, proven identical to what produced the artifact. */
  source: string;
}

function readFileOrThrow(relative: string): Buffer {
  try {
    return readFileSync(`${CONTRACTS_ROOT}${relative}`);
  } catch (err) {
    throw new ArtifactsUnavailableError(
      `could not read contracts/${relative}: ${(err as Error).message}. Run "forge build" in contracts/ first.`,
      { cause: err },
    );
  }
}

/**
 * Loads an artifact and proves the on-disk source is the one it was compiled
 * from. Everything downstream depends on this, so a hash mismatch throws rather
 * than returning a soft failure: parsing a constant out of a source that is not
 * the compiled source would produce a confident, wrong answer.
 */
function verifyContract(name: ContractName): VerifiedContract {
  const paths = CONTRACTS[name];
  const artifact = JSON.parse(readFileOrThrow(paths.artifact).toString("utf8")) as Artifact;

  const recorded = artifact.metadata?.sources?.[paths.source]?.keccak256;
  if (!recorded) {
    throw new Error(
      `contracts/${paths.artifact} carries no metadata hash for ${paths.source}. The artifact is not the one this check understands.`,
    );
  }

  const raw = readFileOrThrow(paths.source);
  const actual = keccak256(toHex(raw));
  if (actual !== recorded) {
    throw new Error(
      `contracts/${paths.source} does not match the compiled artifact (source ${actual}, artifact ${recorded}). Re-run "forge build" and check this again.`,
    );
  }

  return { name, artifact, source: raw.toString("utf8") };
}

/** The ABI must expose the constant as a getter, or the name in `theme-policy.ts`
 *  no longer refers to anything the contract publishes. */
function hasUintGetter(artifact: Artifact, name: string): boolean {
  return artifact.abi.some(
    (item) =>
      item.type === "function" &&
      item.name === name &&
      item.stateMutability === "view" &&
      (item.inputs?.length ?? 0) === 0 &&
      Array.isArray(item.outputs) &&
      item.outputs.length === 1 &&
      (item.outputs[0] as { type?: string }).type === "uint256",
  );
}

/** Reads `uint256 <visibility> constant NAME = <literal>;` out of a source that
 *  has already been hash-matched to the artifact. Underscore separators are
 *  Solidity's own digit grouping and are stripped. */
function constantValue(contract: VerifiedContract, name: string): bigint | null {
  const pattern = new RegExp(
    `uint256\\s+(?:public|internal|private)?\\s*constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`,
  );
  const match = pattern.exec(contract.source);
  const literal = match?.[1];
  if (!literal) return null;
  return BigInt(literal.replace(/_/g, ""));
}

function mirrorCheck(
  contract: VerifiedContract,
  name: string,
  mirrored: number,
  options: { requireGetter: boolean } = { requireGetter: true },
): ConstantCheck {
  const label = `${contract.name}.${name} == ${mirrored}`;

  if (options.requireGetter && !hasUintGetter(contract.artifact, name)) {
    return {
      label,
      ok: false,
      detail: `the compiled ABI has no "${name}() view returns (uint256)" getter. The constant was renamed, made non-public or removed.`,
    };
  }

  const onChain = constantValue(contract, name);
  if (onChain === null) {
    return {
      label,
      ok: false,
      detail: `no "uint256 constant ${name} = <literal>" declaration in the compiled source. It may have become a computed expression, which this check cannot read.`,
    };
  }

  return {
    label,
    ok: onChain === BigInt(mirrored),
    detail:
      onChain === BigInt(mirrored)
        ? `contract ${onChain}, api ${mirrored}`
        : `MIRROR DRIFT: contract ${onChain}, api ${mirrored}. The api would encode calldata against a value the contract does not hold.`,
  };
}

function boundCheck(label: string, ok: boolean, detail: string): ConstantCheck {
  return { label, ok, detail };
}

/**
 * `(name, type, components)` and nothing else, recursively. That triple is
 * exactly what the ABI encoder consumes; solc's `internalType` is documentation
 * and the hand-written ABIs deliberately omit it, so comparing raw JSON would
 * report drift on a decorative field.
 */
function abiShape(params: unknown): string {
  const normalise = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
      const item = entry as { name?: string; type?: string; components?: unknown };
      return {
        name: item.name ?? "",
        type: item.type,
        ...(item.components === undefined ? {} : { components: normalise(item.components) }),
      };
    });
  };
  return JSON.stringify(normalise(params));
}

/**
 * The hand-written `themeFactoryAbi` is what `themeRouter.deploy` encodes with.
 * If its `deployTheme` tuple has drifted from the compiled one, every field
 * after the drift lands in the wrong slot and the factory either reverts or
 * accepts a basket nobody approved. Compared structurally, since the hand-written
 * ABI carries only the members Cortex calls.
 */
function deployThemeSignatureCheck(factory: VerifiedContract): ConstantCheck {
  const label = "themeFactoryAbi.deployTheme matches the compiled ABI";

  const compiled = factory.artifact.abi.find(
    (item) => item.type === "function" && item.name === "deployTheme",
  );
  if (!compiled) {
    return { label, ok: false, detail: "the compiled ABI has no deployTheme function." };
  }

  const local = themeFactoryAbi.find(
    (item) => item.type === "function" && item.name === "deployTheme",
  );
  if (!local) {
    return { label, ok: false, detail: "themeFactoryAbi has no deployTheme function." };
  }

  const compiledShape = abiShape(compiled.inputs);
  const localShape = abiShape((local as { inputs?: unknown }).inputs);

  return {
    label,
    ok: compiledShape === localShape,
    detail:
      compiledShape === localShape
        ? "the parameter tuple is identical field for field"
        : `SIGNATURE DRIFT\n      compiled: ${compiledShape}\n      api:      ${localShape}`,
  };
}

/**
 * Every mirrored constant and every bounded policy choice, checked.
 *
 * Throws `ArtifactsUnavailableError` when `contracts/out` is not built, and a
 * plain `Error` when an artifact and its source disagree. Neither is a check
 * result: the first means the check cannot run here, the second means nothing
 * downstream of it can be trusted.
 */
export function checkMirroredConstants(): ConstantCheck[] {
  const factory = verifyContract("ThemeFactory");
  const vault = verifyContract("KeylessVault");
  const fees = verifyContract("FeeController");

  const checks: ConstantCheck[] = [
    // --- Mirrors -----------------------------------------------------------
    mirrorCheck(factory, "MAX_FEE_BPS", MAX_FEE_BPS),
    mirrorCheck(vault, "MAX_FEE_BPS", MAX_FEE_BPS),
    mirrorCheck(fees, "MAX_FEE_BPS", MAX_FEE_BPS),
    mirrorCheck(factory, "DEVIATION_THRESHOLD_BPS", DEVIATION_THRESHOLD_BPS),
    mirrorCheck(vault, "DEVIATION_THRESHOLD_BPS", DEVIATION_THRESHOLD_BPS),
    mirrorCheck(vault, "MAX_SLIPPAGE_BPS", MAX_SLIPPAGE_BPS),
    mirrorCheck(fees, "PROTOCOL_CUT_BPS", PROTOCOL_CUT_BPS),
    // `BPS` is `internal constant` in all three, so it publishes no getter.
    mirrorCheck(factory, "BPS", BPS, { requireGetter: false }),
    mirrorCheck(vault, "BPS", BPS, { requireGetter: false }),
    mirrorCheck(fees, "BPS", BPS, { requireGetter: false }),

    // --- The encoder itself -------------------------------------------------
    deployThemeSignatureCheck(factory),
  ];

  // --- Bounds on the choices this API makes --------------------------------
  // Each is checked at the WORST case the router can encode, which is the
  // maximum creator fee: the floor both `_validate` and the vault constructor
  // enforce moves with the fee, so a value that clears it at 0 bps proves
  // nothing about a theme deployed at 100.
  const worstFloor = DEVIATION_THRESHOLD_BPS + MAX_FEE_BPS;

  checks.push(
    boundCheck(
      `mintRedeemBandBps > ${worstFloor} at the maximum fee`,
      worstFloor + BAND_HEADROOM_BPS > worstFloor && BAND_HEADROOM_BPS >= 1,
      `BAND_HEADROOM_BPS ${BAND_HEADROOM_BPS} puts the band at ${worstFloor + BAND_HEADROOM_BPS} bps against a floor of ${worstFloor}, and the contracts enforce the floor strictly`,
    ),
    boundCheck(
      `SLIPPAGE_CAP_BPS in (0, ${MAX_SLIPPAGE_BPS}]`,
      SLIPPAGE_CAP_BPS > 0 && SLIPPAGE_CAP_BPS <= MAX_SLIPPAGE_BPS,
      `SLIPPAGE_CAP_BPS ${SLIPPAGE_CAP_BPS} against KeylessVault's "slippageCapBps == 0 || > MAX_SLIPPAGE_BPS reverts"`,
    ),
  );

  return checks;
}
