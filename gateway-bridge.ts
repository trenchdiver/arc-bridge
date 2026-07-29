/**
 * gateway-bridge.ts — Bridge USDC from Base to Arc via Circle Gateway
 *
 * Implements the full 5-step flow:
 *   1. approve + deposit(USDC, amount) on the GatewayWallet contract on Base
 *   2. poll Circle's /v1/balances until the deposit is finalized (~21 min on Base)
 *   3. build + sign an EIP-712 BurnIntent (off-chain, free)
 *   4. POST it to Circle's /v1/transfer → attestation (flat fee, ~0.01 USDC)
 *   5. call gatewayMint(bytes,bytes) on Arc yourself — needs USDC on Arc for gas
 *
 * Setup:
 *   npm init -y && npm pkg set type=module
 *   npm install viem tsx
 *
 * Usage (testnet by default — Base Sepolia → Arc Testnet):
 *   PRIVATE_KEY=0x... AMOUNT_USDC=10 npx tsx gateway-bridge.ts all
 *
 *   Steps are resumable, so you don't have to sit through the finality wait:
 *   npx tsx gateway-bridge.ts deposit    # step 1 only
 *   npx tsx gateway-bridge.ts wait       # step 2 only (counts from deposit time)
 *   npx tsx gateway-bridge.ts wait 0x<depositTx>   # anchor to a specific deposit
 *   npx tsx gateway-bridge.ts transfer   # steps 3–5 (sign, attest, mint)
 *
 * Mainnet:
 *   NETWORK=mainnet ARC_RPC_URL=<arc mainnet rpc> npx tsx gateway-bridge.ts all
 *   (Arc mainnet: Gateway domain 26, chain ID 5042 — both defaulted.)
 *
 * Env vars:
 *   PRIVATE_KEY     required — EOA hex key (Gateway only accepts EOA signatures)
 *   AMOUNT_USDC     amount to mint on Arc (default "10")
 *   MAX_FEE_USDC    max fee Circle may take, on top of AMOUNT (default "0.05";
 *                   actual fee has been a flat 0.01 — your Gateway balance must
 *                   cover AMOUNT + fee, hence the "required 10.01" rejections)
 *   RECIPIENT       Arc address to receive USDC (default: your own address)
 *   NETWORK         "testnet" (default) or "mainnet"
 *   BASE_RPC_URL    optional custom RPC for Base
 *   GW_EXTRA_HEADERS  additional Gateway API headers, "Key: value"
 *                   (newline- or comma-separated). The Arc private-mainnet
 *                   header is already sent by default.
 *   ARC_RPC_URL     Arc RPC (has a testnet default; required on mainnet)
 *   ARC_CHAIN_ID    Arc chain id (required on mainnet)
 *   ARC_DOMAIN      Gateway domain id for Arc (default 26 = Arc Testnet;
 *                   required on mainnet)
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  pad,
  parseUnits,
  zeroAddress,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Load .env from the current directory if present (Node 20.12+ built-in).
// Must happen before any process.env reads below.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    console.warn("Found .env but couldn't load it — needs Node 20.12+ (or use --env-file=.env)");
  }
}

const NETWORK = (process.env.NETWORK ?? "testnet") as "testnet" | "mainnet";
const IS_MAINNET = NETWORK === "mainnet";

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const AMOUNT = parseUnits(process.env.AMOUNT_USDC ?? "10", 6); // USDC is 6 decimals
const MAX_FEE = parseUnits(process.env.MAX_FEE_USDC ?? "0.05", 6);
const RECIPIENT = (process.env.RECIPIENT?.trim() || account.address) as `0x${string}`;

// Gateway contracts — same address on every EVM chain within an environment.
// Source: circlefin/skills use-gateway (official) + developers.circle.com
const GATEWAY_WALLET = (
  IS_MAINNET
    ? "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
    : "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
) as `0x${string}`;
const GATEWAY_MINTER = (
  IS_MAINNET
    ? "0x2222222d7164433c4C09B0b0D809a9b52C04C205"
    : "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B"
) as `0x${string}`;

const API_BASE = IS_MAINNET
  ? "https://gateway-api.circle.com/v1"
  : "https://gateway-api-testnet.circle.com/v1";

// Headers for Gateway API calls. The Arc flag is sent by default; add more via
//   GW_EXTRA_HEADERS="Key: value"   (newline- or comma-separated for multiple)
// Note: always sent over HTTPS (API_BASE above) — never send signed payloads
// or fetch anything you're going to sign over plain http.
function gatewayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-ARC-PRIVATE-MAINNET-ENABLED": "true",
  };
  const raw = process.env.GW_EXTRA_HEADERS?.trim();
  if (!raw) return headers;

  for (const part of raw.split(/[\n,]/)) {
    const line = part.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      console.warn(`      ignoring malformed GW_EXTRA_HEADERS entry (no colon): ${line}`);
      continue;
    }
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// Domains (Gateway's chain IDs, not EVM chain IDs)
const BASE_DOMAIN = 6; // Base + Base Sepolia are both domain 6
const ARC_DOMAIN = Number(process.env.ARC_DOMAIN ?? 26); // Arc is 26 on both testnet and mainnet

// USDC addresses
const BASE_USDC = (
  IS_MAINNET
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" // Base mainnet
    : "0x036CbD53842c5426634e7929541eC2318f3dCF7e" // Base Sepolia
) as `0x${string}`;
// Arc's USDC is a predeploy and doubles as the gas token
const ARC_USDC = (process.env.ARC_USDC ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

// Chains
const baseChain: Chain = IS_MAINNET ? base : baseSepolia;

if (IS_MAINNET && !process.env.ARC_RPC_URL)
  throw new Error("Set ARC_RPC_URL for Arc mainnet (see docs.arc.network for endpoints)");

const arcChain: Chain = defineChain({
  id: Number(process.env.ARC_CHAIN_ID ?? (IS_MAINNET ? 5042 : 5042002)),
  name: "Arc",
  // Arc's native gas IS USDC, with 6 decimals — not 18 like typical EVM chains
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io"],
    },
  },
});

const basePublic = createPublicClient({
  chain: baseChain,
  transport: http(process.env.BASE_RPC_URL),
});
const baseWallet = createWalletClient({
  account,
  chain: baseChain,
  transport: http(process.env.BASE_RPC_URL),
});
const arcPublic = createPublicClient({ chain: arcChain, transport: http() });
const arcWallet = createWalletClient({ account, chain: arcChain, transport: http() });

// ---------------------------------------------------------------------------
// ABIs (only the functions we call)
// ---------------------------------------------------------------------------

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "availableBalance",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ---------------------------------------------------------------------------
// EIP-712 typed data — copied verbatim from Circle's official reference.
// Do NOT reorder, rename, or omit fields: the signature becomes invalid.
// Addresses are left-padded to bytes32 (cross-VM compatibility with Solana).
// ---------------------------------------------------------------------------

const typedData = {
  domain: { name: "GatewayWallet", version: "1" },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ],
    TransferSpec: [
      { name: "version", type: "uint32" },
      { name: "sourceDomain", type: "uint32" },
      { name: "destinationDomain", type: "uint32" },
      { name: "sourceContract", type: "bytes32" },
      { name: "destinationContract", type: "bytes32" },
      { name: "sourceToken", type: "bytes32" },
      { name: "destinationToken", type: "bytes32" },
      { name: "sourceDepositor", type: "bytes32" },
      { name: "destinationRecipient", type: "bytes32" },
      { name: "sourceSigner", type: "bytes32" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "value", type: "uint256" },
      { name: "salt", type: "bytes32" },
      { name: "hookData", type: "bytes" },
    ],
    BurnIntent: [
      { name: "maxBlockHeight", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "spec", type: "TransferSpec" },
    ],
  },
  primaryType: "BurnIntent",
} as const;

const toBytes32 = (addr: `0x${string}`) =>
  pad(addr.toLowerCase() as `0x${string}`, { size: 32 });

const fmt = (v: bigint) => formatUnits(v, 6);

// ---------------------------------------------------------------------------
// Deposit anchor state — lets `wait` count from the deposit, not from when
// you happened to start the script. Written by step 1, read by step 2.
// ---------------------------------------------------------------------------

const STATE_FILE = ".gateway-state.json";

// Circle waits ~65 ETH blocks for Base deposits: ~13-19 min in practice.
const FINALITY_MIN_SECONDS = 13 * 60;
const FINALITY_MAX_SECONDS = Number(process.env.FINALITY_MAX_MINUTES ?? 19) * 60;

type DepositAnchor = {
  depositTx: `0x${string}`;
  blockNumber: string; // bigint serialized
  timestamp: number; // unix seconds, from the block header
  amount: string;
  network: string;
};

function saveAnchor(a: DepositAnchor) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(a, null, 2));
  } catch (e) {
    console.warn(`      couldn't write ${STATE_FILE}: ${(e as Error).message}`);
  }
}

function loadAnchor(): DepositAnchor | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const a = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DepositAnchor;
    return a.network === NETWORK ? a : null;
  } catch {
    return null;
  }
}

/** Resolve when the deposit actually landed: CLI tx hash > state file > now. */
async function resolveAnchor(txArg?: string): Promise<{
  blockNumber: bigint;
  timestamp: number;
  origin: string;
}> {
  if (txArg?.startsWith("0x")) {
    const receipt = await basePublic.getTransactionReceipt({ hash: txArg as `0x${string}` });
    const block = await basePublic.getBlock({ blockNumber: receipt.blockNumber });
    return {
      blockNumber: receipt.blockNumber,
      timestamp: Number(block.timestamp),
      origin: `tx ${txArg.slice(0, 10)}…`,
    };
  }

  const saved = loadAnchor();
  if (saved) {
    return {
      blockNumber: BigInt(saved.blockNumber),
      timestamp: saved.timestamp,
      origin: `${STATE_FILE} (tx ${saved.depositTx.slice(0, 10)}…)`,
    };
  }

  const block = await basePublic.getBlock();
  console.log(`      No deposit record found — counting from now instead.`);
  console.log(`      To anchor properly: npx tsx gateway-bridge.ts wait 0x<depositTxHash>`);
  return {
    blockNumber: block.number,
    timestamp: Number(block.timestamp),
    origin: "script start (no deposit record)",
  };
}

const hhmm = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// ---------------------------------------------------------------------------
// Step 1 — Deposit on Base
// ---------------------------------------------------------------------------

async function step1_deposit() {
  // Balance must cover AMOUNT + fee ("required 10.01"-style rejections
  // mean the fee wasn't covered), so deposit AMOUNT + MAX_FEE.
  const depositAmount = AMOUNT + MAX_FEE;

  console.log(`\n[1/5] Depositing ${fmt(depositAmount)} USDC into GatewayWallet on ${baseChain.name}`);
  console.log(`      (= ${fmt(AMOUNT)} to bridge + ${fmt(MAX_FEE)} fee headroom)`);
  console.log(`      NEVER plain-transfer USDC to the GatewayWallet — it will be lost.`);

  const allowance = await basePublic.readContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, GATEWAY_WALLET],
  });

  if (allowance < depositAmount) {
    const approveTx = await baseWallet.writeContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [GATEWAY_WALLET, depositAmount],
    });
    const approveReceipt = await basePublic.waitForTransactionReceipt({ hash: approveTx });
    if (approveReceipt.status !== "success") {
      throw new Error(`Approve tx reverted: ${approveTx}`);
    }
    console.log(`      approved: ${approveTx}`);

    // Public RPCs load-balance across nodes; the node that simulates the
    // deposit may lag the one that mined the approval. Wait until the
    // allowance is actually visible before proceeding.
    for (let i = 0; i < 30; i++) {
      const current = await basePublic.readContract({
        address: BASE_USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, GATEWAY_WALLET],
      });
      if (current >= depositAmount) break;
      if (i === 29) throw new Error("Allowance still not visible after 60s — rerun `deposit`");
      console.log(`      waiting for allowance to propagate...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const depositTx = await baseWallet.writeContract({
    address: GATEWAY_WALLET,
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [BASE_USDC, depositAmount],
  });
  // Print first: everything below can fail on a lagging RPC, and losing this
  // hash is far more painful than losing the bookkeeping.
  console.log(`      deposit tx: ${depositTx}`);

  const depositReceipt = await basePublic.waitForTransactionReceipt({ hash: depositTx });
  if (depositReceipt.status !== "success") {
    throw new Error(`Deposit tx reverted: ${depositTx}`);
  }
  console.log(`      landed in Base block ${depositReceipt.blockNumber} — finality clock starts here`);

  // Block header gives the true deposit time. A load-balanced RPC may not have
  // this block yet, so retry, then fall back to local clock — never throw here:
  // the deposit is already on-chain and must not look like a failure.
  let depositTimestamp = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    try {
      const block = await basePublic.getBlock({ blockNumber: depositReceipt.blockNumber });
      depositTimestamp = Number(block.timestamp);
      break;
    } catch {
      if (i === 4) {
        console.warn(`      couldn't read block timestamp — using local clock for the countdown`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  saveAnchor({
    depositTx,
    blockNumber: depositReceipt.blockNumber.toString(),
    timestamp: depositTimestamp,
    amount: depositAmount.toString(),
    network: NETWORK,
  });

  const onchain = await basePublic.readContract({
    address: GATEWAY_WALLET,
    abi: gatewayWalletAbi,
    functionName: "availableBalance",
    args: [BASE_USDC, account.address],
  });
  console.log(`      on-chain availableBalance: ${fmt(onchain)} USDC (still yours, nothing burned)`);
}

// ---------------------------------------------------------------------------
// Step 2 — Wait for Circle's indexer (finality window, ~21 min on Base)
// ---------------------------------------------------------------------------

async function circleBalance(): Promise<bigint> {
  const res = await fetch(`${API_BASE}/balances`, {
    method: "POST",
    headers: gatewayHeaders(),
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: BASE_DOMAIN, depositor: account.address }],
    }),
  });
  if (!res.ok) throw new Error(`/balances failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    balances: { domain: number; balance: string }[];
  };
  const entry = json.balances?.find((b) => b.domain === BASE_DOMAIN);
  return parseUnits(entry?.balance ?? "0", 6); // API returns human-readable units
}

async function step2_waitForIndexer(txArg?: string) {
  const need = AMOUNT + MAX_FEE;
  console.log(`\n[2/5] Waiting for Circle to index the deposit (needs ${fmt(need)} USDC available)`);

  const anchor = await resolveAnchor(txArg);
  const depositedAt = new Date(anchor.timestamp * 1000);
  console.log(`      anchored to: ${anchor.origin}`);
  console.log(`      deposit landed: ${depositedAt.toLocaleTimeString()} (Base block ${anchor.blockNumber})`);
  console.log(`      Circle waits ~65 ETH blocks on Base — typically 13-19 min from that block.`);

  for (;;) {
    const [bal, head] = await Promise.all([circleBalance(), basePublic.getBlockNumber()]);

    // Elapsed measured from the deposit block's timestamp, not script start
    const elapsed = Math.floor(Date.now() / 1000) - anchor.timestamp;
    const blocks = head - anchor.blockNumber;
    const remaining = FINALITY_MAX_SECONDS - elapsed;

    const eta =
      elapsed < FINALITY_MIN_SECONDS
        ? `~${hhmm(FINALITY_MIN_SECONDS - elapsed)}-${hhmm(remaining)} left`
        : remaining > 0
          ? `up to ~${hhmm(remaining)} left`
          : `past the expected window (${hhmm(-remaining)} over) — still polling`;

    console.log(
      `      [+${hhmm(elapsed)} | ${blocks} Base blocks] indexed: ${fmt(bal)}/${fmt(need)} USDC — ${eta}`,
    );

    if (bal >= need) break;
    await new Promise((r) => setTimeout(r, 30_000)); // poll every 30s
  }

  const total = Math.floor(Date.now() / 1000) - anchor.timestamp;
  console.log(`      Deposit finalized and indexed after ${hhmm(total)}.`);
}

// ---------------------------------------------------------------------------
// Steps 3 + 4 — Sign burn intent, request attestation
// ---------------------------------------------------------------------------

async function steps3and4_signAndAttest(): Promise<{
  attestation: `0x${string}`;
  signature: `0x${string}`;
}> {
  console.log(`\n[3/5] Signing EIP-712 burn intent (off-chain, free)`);

  const burnIntent = {
    maxBlockHeight: maxUint256, // no expiry; use a real block ceiling in prod
    maxFee: MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: BASE_DOMAIN,
      destinationDomain: ARC_DOMAIN,
      sourceContract: toBytes32(GATEWAY_WALLET),
      destinationContract: toBytes32(GATEWAY_MINTER),
      sourceToken: toBytes32(BASE_USDC),
      destinationToken: toBytes32(ARC_USDC),
      sourceDepositor: toBytes32(account.address),
      destinationRecipient: toBytes32(RECIPIENT),
      sourceSigner: toBytes32(account.address),
      destinationCaller: toBytes32(zeroAddress), // 0 = anyone may submit the mint
      value: AMOUNT,
      salt: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      hookData: "0x" as `0x${string}`,
    },
  };

  const signature = await account.signTypedData({ ...typedData, message: burnIntent });
  console.log(`      signed by ${account.address}`);

  console.log(`\n[4/5] Requesting attestation from Circle (${API_BASE}/transfer)`);
  const headers = gatewayHeaders();
  const extra = Object.keys(headers).filter((h) => h !== "Content-Type");
  if (extra.length) console.log(`      extra headers: ${extra.join(", ")}`);

  const res = await fetch(`${API_BASE}/transfer`, {
    method: "POST",
    headers,
    // API expects decimal strings, not JS bigints
    body: JSON.stringify([{ burnIntent, signature }], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  });

  if (!res.ok) {
    const text = await res.text();
    // Their rejection text states the exact required amount — surface it
    throw new Error(
      `/transfer rejected (${res.status}): ${text}\n` +
        `Hint: your indexed balance must cover value + fee. If it says "required X", ` +
        `that X is value + the flat transfer fee (~0.01 USDC).`,
    );
  }

  const { attestation, signature: circleSig } = (await res.json()) as {
    attestation: `0x${string}`;
    signature: `0x${string}`;
  };
  console.log(`      attestation received (expires in ~10 minutes — mint promptly)`);
  return { attestation, signature: circleSig };
}

// ---------------------------------------------------------------------------
// Step 5 — Submit the mint on Arc yourself
// ---------------------------------------------------------------------------

async function step5_mintOnArc(attestation: `0x${string}`, circleSig: `0x${string}`) {
  console.log(`\n[5/5] Submitting gatewayMint on Arc — Circle does NOT do this for you`);

  // The bootstrap trap: Arc gas is paid in USDC (the native token).
  // Check we can actually pay for the mint before burning 10 minutes.
  const gasBalance = await arcPublic.getBalance({ address: account.address });
  if (gasBalance === 0n) {
    throw new Error(
      `Bootstrap paradox: ${account.address} has zero gas (USDC) on Arc, ` +
        `so it can't pay for the mint that would give it USDC on Arc. ` +
        `Fund it first (OTC, faucet on testnet, or a sponsored/relayed tx), then rerun:\n` +
        `  npx tsx gateway-bridge.ts mint  (attestation must still be <10 min old — ` +
        `otherwise rerun "transfer" to get a fresh one)`,
    );
  }
  // Arc's eth_getBalance returns 18-decimal native units even though USDC is a
  // 6-decimal token, so format with 18 here (raw shown for sanity-checking).
  console.log(`      Arc gas balance: ${formatUnits(gasBalance, 18)} USDC (raw ${gasBalance})`);

  const mintTx = await arcWallet.writeContract({
    address: GATEWAY_MINTER,
    abi: gatewayMinterAbi,
    functionName: "gatewayMint",
    args: [attestation, circleSig],
  });
  const receipt = await arcPublic.waitForTransactionReceipt({ hash: mintTx });

  console.log(`      mint tx: ${mintTx} (status: ${receipt.status})`);
  console.log(`\nDone. ${fmt(AMOUNT)} USDC minted to ${RECIPIENT} on Arc.`);
  console.log(`Circle's system now burns the corresponding balance on Base — that part is theirs.`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2] ?? "all";
  console.log(`Network: ${NETWORK} | Base domain ${BASE_DOMAIN} → Arc domain ${ARC_DOMAIN}`);
  console.log(`Account: ${account.address} | Bridging ${fmt(AMOUNT)} USDC to ${RECIPIENT}`);

  if (IS_MAINNET) {
    console.log(`\n*** MAINNET: real funds. Double-check ARC_DOMAIN, ARC_USDC, ARC_CHAIN_ID ***`);
  }

  switch (cmd) {
    case "deposit":
      await step1_deposit();
      console.log(`\nNext: npx tsx gateway-bridge.ts wait`);
      break;
    case "wait":
      await step2_waitForIndexer(process.argv[3]);
      console.log(`\nNext: npx tsx gateway-bridge.ts transfer`);
      break;
    case "transfer": {
      const { attestation, signature } = await steps3and4_signAndAttest();
      await step5_mintOnArc(attestation, signature);
      break;
    }
    case "all":
      await step1_deposit();
      await step2_waitForIndexer();
      {
        const { attestation, signature } = await steps3and4_signAndAttest();
        await step5_mintOnArc(attestation, signature);
      }
      break;
    default:
      throw new Error(`Unknown command "${cmd}". Use: deposit | wait | transfer | all`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
