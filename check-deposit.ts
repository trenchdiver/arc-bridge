/**
 * check-deposit.ts — Confirm a Gateway deposit landed and recover its tx hash.
 *
 *   npx tsx check-deposit.ts
 *
 * Reads availableBalance() on the GatewayWallet (on-chain truth) and scans
 * recent blocks for your Deposit events so you can recover a tx hash that
 * scrolled past or was never printed.
 */

import { existsSync } from "node:fs";
import { createPublicClient, formatUnits, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" as const;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

const walletAbi = [
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

async function main() {
  const bal = await client.readContract({
    address: GATEWAY_WALLET,
    abi: walletAbi,
    functionName: "availableBalance",
    args: [BASE_USDC, account.address],
  });
  console.log(`On-chain GatewayWallet balance for ${account.address}:`);
  console.log(`  ${formatUnits(bal, 6)} USDC`);

  const head = await client.getBlockNumber();
  const from = head - 3000n > 0n ? head - 3000n : 0n; // ~100 min of Base blocks

  const logs = await client.getLogs({
    address: GATEWAY_WALLET,
    event: parseAbiItem(
      "event Deposited(address indexed token, address indexed depositor, uint256 value)",
    ),
    args: { token: BASE_USDC, depositor: account.address },
    fromBlock: from,
    toBlock: head,
  }).catch(() => []);

  if (!logs.length) {
    console.log(`\nNo Deposit events in the last ~3000 blocks.`);
    console.log(`Check Basescan directly: https://basescan.org/address/${account.address}`);
    return;
  }

  console.log(`\nRecent deposits (newest last):`);
  for (const log of logs) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    const when = new Date(Number(block.timestamp) * 1000).toLocaleTimeString();
    console.log(
      `  ${formatUnits((log.args as { value: bigint }).value, 6).padStart(12)} USDC` +
        ` | block ${log.blockNumber} | ${when} | ${log.transactionHash}`,
    );
  }

  const last = logs[logs.length - 1];
  console.log(`\nResume the wait anchored to that deposit:`);
  console.log(`  npx tsx gateway-bridge.ts wait ${last.transactionHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
