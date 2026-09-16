/** Current static-v5 call ABI, generated from pinned Solidity artifacts.
 * Historical events remain read-only so existing deployments can still be indexed.
 * No legacy rebalance function is exposed here. Source changes do not upgrade vaults.
 */
export const keylessVaultEventsAbi = [
  {
    type: "event",
    name: "DeferredClaimed",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "index",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "to",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ExitDeferred",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "index",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "units",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "InKindLegFailed",
    inputs: [
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Minted",
    inputs: [
      {
        name: "caller",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "shares",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "depositValueUsd",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      {
        name: "caller",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "shares",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "failedLegs",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RedeemedToUsdg",
    inputs: [
      {
        name: "caller",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "shares",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "usdgOut",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "KeeperReimbursementSkipped",
    inputs: [
      {
        name: "keeper",
        type: "address",
        indexed: true,
      },
      {
        name: "amountWei",
        type: "uint256",
        indexed: false,
      },
      {
        name: "reason",
        type: "uint8",
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "KeeperReimbursed",
    inputs: [
      {
        name: "keeper",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amountWei",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Rebalanced",
    inputs: [
      {
        name: "keeper",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "driftBefore",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "driftAfter",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const;
export const keylessVaultAbi = [
  ...[
    {
      type: "function",
      name: "DEVIATION_THRESHOLD_BPS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "IN_KIND_LEG_GAS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "MAX_FEE_BPS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "MAX_SLIPPAGE_BPS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "MAX_STALENESS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "MIN_MINT_SHARES",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "activeBalance",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "allowedVenues",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address[]",
          internalType: "address[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "capsBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256[]",
          internalType: "uint256[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "claimDeferred",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
      ],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "constituentCount",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "constituentIndicative",
      inputs: [
        {
          name: "i",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "",
          type: "bool",
          internalType: "bool",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "constituents",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address[]",
          internalType: "address[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "creator",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "creatorFeeBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "currentDriftBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "currentWeightsBps",
      inputs: [],
      outputs: [
        {
          name: "weights",
          type: "uint256[]",
          internalType: "uint256[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "deferredBalance",
      inputs: [
        {
          name: "owner",
          type: "address",
          internalType: "address",
        },
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "deferredUnits",
      inputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "feeds",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address[]",
          internalType: "address[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "isAllowedVenue",
      inputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      outputs: [
        {
          name: "",
          type: "bool",
          internalType: "bool",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "maxRedeemUsd",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "mint",
      inputs: [
        {
          name: "amountsIn",
          type: "uint256[]",
          internalType: "uint256[]",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
        {
          name: "minSharesOut",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "mintRedeemBandBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "mintWithUsdg",
      inputs: [
        {
          name: "usdgIn",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "venue",
          type: "address",
          internalType: "address",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
        {
          name: "minSharesOut",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "mintWithUsdgUntil",
      inputs: [
        {
          name: "usdgIn",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "venue",
          type: "address",
          internalType: "address",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
        {
          name: "minSharesOut",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "deadline",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "navIndicative",
      inputs: [],
      outputs: [
        {
          name: "value",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "stale",
          type: "bool",
          internalType: "bool",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "navPerShare",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "navValue",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "redeem",
      inputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
      ],
      outputs: [
        {
          name: "tokens",
          type: "address[]",
          internalType: "address[]",
        },
        {
          name: "amounts",
          type: "uint256[]",
          internalType: "uint256[]",
        },
        {
          name: "failed",
          type: "address[]",
          internalType: "address[]",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "redeemInKindLeg",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "units",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "owner",
          type: "address",
          internalType: "address",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
      ],
      outputs: [
        {
          name: "amount",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "redeemToUsdg",
      inputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "venue",
          type: "address",
          internalType: "address",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
        {
          name: "minUsdgOut",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "usdgOut",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "redeemToUsdgUntil",
      inputs: [
        {
          name: "shares",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "venue",
          type: "address",
          internalType: "address",
        },
        {
          name: "to",
          type: "address",
          internalType: "address",
        },
        {
          name: "minUsdgOut",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "deadline",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "usdgOut",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "slippageCapBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "targetWeightsBps",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256[]",
          internalType: "uint256[]",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "themeToken",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "contract ThemeToken",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "usdg",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "error",
      name: "AmountTooSmall",
      inputs: [],
    },
    {
      type: "error",
      name: "AssetInsolvent",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "BadAnswer",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "answer",
          type: "int256",
          internalType: "int256",
        },
      ],
    },
    {
      type: "error",
      name: "BadCap",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "BadRecipient",
      inputs: [],
    },
    {
      type: "error",
      name: "BadSlippageCap",
      inputs: [],
    },
    {
      type: "error",
      name: "BandNotAboveThreshold",
      inputs: [],
    },
    {
      type: "error",
      name: "ConstituentHasNoFeed",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "DeadlineExpired",
      inputs: [
        {
          name: "deadline",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "DepositOffTargetWeight",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "FeeAboveCap",
      inputs: [],
    },
    {
      type: "error",
      name: "FeedNotResponding",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "InsufficientExitGas",
      inputs: [],
    },
    {
      type: "error",
      name: "InvalidConfiguration",
      inputs: [],
    },
    {
      type: "error",
      name: "InvalidConstituent",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "LengthMismatch",
      inputs: [],
    },
    {
      type: "error",
      name: "MaxRedeemExceeded",
      inputs: [],
    },
    {
      type: "error",
      name: "NoConstituents",
      inputs: [],
    },
    {
      type: "error",
      name: "NoDeferredClaim",
      inputs: [],
    },
    {
      type: "error",
      name: "NoSupply",
      inputs: [],
    },
    {
      type: "error",
      name: "NoVenues",
      inputs: [],
    },
    {
      type: "error",
      name: "NotAVaultAsset",
      inputs: [
        {
          name: "token",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "NothingDeposited",
      inputs: [],
    },
    {
      type: "error",
      name: "OnlySelf",
      inputs: [],
    },
    {
      type: "error",
      name: "ReentrancyGuardReentrantCall",
      inputs: [],
    },
    {
      type: "error",
      name: "RoundIncomplete",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "SafeERC20FailedOperation",
      inputs: [
        {
          name: "token",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "SettlementMismatch",
      inputs: [
        {
          name: "token",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "SharesExceedSupply",
      inputs: [],
    },
    {
      type: "error",
      name: "SlippageExceeded",
      inputs: [],
    },
    {
      type: "error",
      name: "StaleFeed",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "age",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "UnsupportedTransfer",
      inputs: [
        {
          name: "token",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "VenueNotAllowed",
      inputs: [
        {
          name: "venue",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "WeightsMustSumToBps",
      inputs: [
        {
          name: "got",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "ZeroAddress",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroAmount",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroShares",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroWeight",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
  ],
  ...keylessVaultEventsAbi,
] as const;
export const themeFactoryEventsAbi = [
  {
    type: "event",
    name: "ThemeComposition",
    inputs: [
      {
        name: "policyHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "themeToken",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "constituents",
        type: "address[]",
        indexed: false,
        internalType: "address[]",
      },
      {
        name: "feeds",
        type: "address[]",
        indexed: false,
        internalType: "address[]",
      },
      {
        name: "targetWeightsBps",
        type: "uint256[]",
        indexed: false,
        internalType: "uint256[]",
      },
      {
        name: "capsBps",
        type: "uint256[]",
        indexed: false,
        internalType: "uint256[]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ThemeDeployed",
    inputs: [
      {
        name: "policyHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "themeToken",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "slug",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "vault",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "feeController",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "usdg",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "creatorFeeBps",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "mintRedeemBandBps",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ThemeDeployed",
    inputs: [
      {
        name: "policyHash",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
      },
      {
        name: "themeToken",
        type: "address",
        indexed: true,
      },
      {
        name: "slug",
        type: "string",
        indexed: false,
      },
      {
        name: "vault",
        type: "address",
        indexed: false,
      },
      {
        name: "feeController",
        type: "address",
        indexed: false,
      },
      {
        name: "usdg",
        type: "address",
        indexed: false,
      },
      {
        name: "creatorFeeBps",
        type: "uint256",
        indexed: false,
      },
      {
        name: "mintRedeemBandBps",
        type: "uint256",
        indexed: false,
      },
      {
        name: "driftBandBps",
        type: "uint256",
        indexed: false,
      },
    ],
  },
] as const;
export const themeFactoryAbi = [
  ...[
    {
      type: "function",
      name: "DEVIATION_THRESHOLD_BPS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "MAX_FEE_BPS",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "deployTheme",
      inputs: [
        {
          name: "params",
          type: "tuple",
          internalType: "struct ThemeFactory.ThemeParams",
          components: [
            {
              name: "slug",
              type: "string",
              internalType: "string",
            },
            {
              name: "name",
              type: "string",
              internalType: "string",
            },
            {
              name: "symbol",
              type: "string",
              internalType: "string",
            },
            {
              name: "decimals",
              type: "uint8",
              internalType: "uint8",
            },
            {
              name: "creator",
              type: "address",
              internalType: "address",
            },
            {
              name: "usdg",
              type: "address",
              internalType: "address",
            },
            {
              name: "constituents",
              type: "address[]",
              internalType: "address[]",
            },
            {
              name: "feeds",
              type: "address[]",
              internalType: "address[]",
            },
            {
              name: "targetWeightsBps",
              type: "uint256[]",
              internalType: "uint256[]",
            },
            {
              name: "capsBps",
              type: "uint256[]",
              internalType: "uint256[]",
            },
            {
              name: "creatorFeeBps",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "mintRedeemBandBps",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "slippageCapBps",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "maxRedeemUsd",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "allowedVenues",
              type: "address[]",
              internalType: "address[]",
            },
          ],
        },
      ],
      outputs: [
        {
          name: "themeToken",
          type: "address",
          internalType: "contract ThemeToken",
        },
        {
          name: "vault",
          type: "address",
          internalType: "contract KeylessVault",
        },
        {
          name: "feeController",
          type: "address",
          internalType: "contract FeeController",
        },
      ],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "deployedCount",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "deployedVaults",
      inputs: [
        {
          name: "",
          type: "uint256",
          internalType: "uint256",
        },
      ],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "predictedNextVault",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "protocolFeeSink",
      inputs: [],
      outputs: [
        {
          name: "",
          type: "address",
          internalType: "address",
        },
      ],
      stateMutability: "view",
    },
    {
      type: "error",
      name: "BadCap",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "ConstituentHasNoFeed",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "CreatorMustBeCaller",
      inputs: [],
    },
    {
      type: "error",
      name: "EmptyName",
      inputs: [],
    },
    {
      type: "error",
      name: "EmptySlug",
      inputs: [],
    },
    {
      type: "error",
      name: "EmptySymbol",
      inputs: [],
    },
    {
      type: "error",
      name: "FeeAboveCap",
      inputs: [],
    },
    {
      type: "error",
      name: "FeedNotResponding",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "LengthMismatch",
      inputs: [],
    },
    {
      type: "error",
      name: "MintRedeemBandTooTight",
      inputs: [],
    },
    {
      type: "error",
      name: "NoConstituents",
      inputs: [],
    },
    {
      type: "error",
      name: "NoVenues",
      inputs: [],
    },
    {
      type: "error",
      name: "VaultAddressMismatch",
      inputs: [
        {
          name: "predicted",
          type: "address",
          internalType: "address",
        },
        {
          name: "actual",
          type: "address",
          internalType: "address",
        },
      ],
    },
    {
      type: "error",
      name: "WeightsMustSumToBps",
      inputs: [
        {
          name: "got",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "ZeroConstituent",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "ZeroCreator",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroProtocolFeeSink",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroUsdg",
      inputs: [],
    },
    {
      type: "error",
      name: "ZeroVenue",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      type: "error",
      name: "ZeroWeight",
      inputs: [
        {
          name: "index",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
  ],
  ...themeFactoryEventsAbi,
] as const;
