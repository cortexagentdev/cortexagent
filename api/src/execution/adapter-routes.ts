import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
  type Address,
} from "viem";
import seed from "../../data/venues.json";

export const adapterRouteParameters = parseAbiParameters(
  "uint256 schemaVersion, string protocolVariant, address factory, address router, address quoter, (address tokenIn,address tokenOut,uint24 fee,address pool)[] routes",
);
export type AdapterRoute = { tokenIn: Address; tokenOut: Address; fee: number; pool: Address };
export function adapterPath(route: AdapterRoute) {
  return encodePacked(["address", "uint24", "address"], [route.tokenIn, route.fee, route.tokenOut]);
}
export function adapterConfiguration() {
  const venue = seed.venues[0]!;
  const routes: AdapterRoute[] = venue.pools
    .flatMap((pool) => [
      {
        tokenIn: pool.token0 as Address,
        tokenOut: pool.token1 as Address,
        fee: pool.feePips,
        pool: pool.address as Address,
      },
      {
        tokenIn: pool.token1 as Address,
        tokenOut: pool.token0 as Address,
        fee: pool.feePips,
        pool: pool.address as Address,
      },
    ])
    .sort((a, b) => a.tokenIn.localeCompare(b.tokenIn) || a.tokenOut.localeCompare(b.tokenOut));
  const factory = venue.factory as Address;
  const router = venue.router as Address;
  const quoter = venue.quoter as Address;
  const routeHash = keccak256(
    encodeAbiParameters(adapterRouteParameters, [
      1n,
      venue.protocolVariant,
      factory,
      router,
      quoter,
      routes,
    ]),
  );
  return { factory, router, quoter, routes, routeHash, protocolVariant: venue.protocolVariant };
}
