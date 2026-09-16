/** An estimate at the current block can miss next-block pool observation
 * writes. Reserve 30%, rounded up; unused gas is not charged. This does not
 * bypass simulation, reverts or the chain's gas limit. */
export function withGasMargin(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error("A positive gas estimate is required.");
  return (estimate * 130n + 99n) / 100n;
}
