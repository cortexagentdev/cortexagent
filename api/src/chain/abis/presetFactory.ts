import { parseAbi } from "viem";
import { themeFactoryAbi } from "./keylessVault.ts";

/** Deployment tuple is unchanged; authorization and the finite catalog live
 * in the preset release. Check these selectors against its compiled artifact. */
export const presetFactoryAbi = [
  ...themeFactoryAbi,
  ...parseAbi([
    "function RELEASE() view returns (string)",
    "function presetDeployer() view returns (address)",
    "function catalogHash() view returns (bytes32)",
    "function presetCount() view returns (uint256)",
    "function presetIds() view returns (bytes32[])",
    "function allowedPreset(bytes32) view returns (bool)",
    "function presetsComplete() view returns (bool)",
    "function presets(bytes32) view returns (address token, address vault, address feeController, bytes32 policyHash, uint256 blockNumber)",
    "event PresetRegistered(bytes32 indexed presetId, address indexed token, address indexed vault)",
    "error UnauthorizedDeployer()",
    "error InvalidPresetCatalog()",
    "error UnknownPreset()",
    "error PresetAlreadyDeployed()",
    "error NonzeroCreatorFee()",
  ]),
] as const;
