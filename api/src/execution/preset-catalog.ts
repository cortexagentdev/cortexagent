import { keccak256, toHex } from "viem";
import lenses from "../../data/lenses.json";
import assets from "../../data/execution-tokens.json";
import { PRESET_RELEASE } from "./vault-accounting.ts";

/** No database or runtime environment dependency: release tooling and the
 * application commit to the same finite catalog before any vault is created. */
export const PRESET_SLUGS = lenses.map((lens) => lens.slug);
export const presetId = (slug: string) => keccak256(toHex(slug));
export const PRESET_IDS = PRESET_SLUGS.map(presetId);
const catalog = lenses.map((lens) => ({
  slug: lens.slug,
  members: lens.members.map((member) => {
    const asset = assets.stocks.find((stock) => stock.symbol === member.symbol);
    if (!asset)
      throw new Error(`Preset ${lens.slug}: missing authenticated asset ${member.symbol}`);
    return { ...member, token: asset.address.toLowerCase(), feed: asset.feed.toLowerCase() };
  }),
}));
export const PRESET_CATALOG_HASH = keccak256(
  toHex(JSON.stringify({ release: PRESET_RELEASE, catalog })),
);
if (
  new Set(PRESET_SLUGS).size !== PRESET_SLUGS.length ||
  PRESET_SLUGS.length === 0 ||
  PRESET_SLUGS.length > 64
)
  throw new Error("Invalid predefined lens catalog");
