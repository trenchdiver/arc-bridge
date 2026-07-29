# arc-bridge

Move USDC from **Base** to **Arc** with direct contract calls. 

| Route | Script | How it works |
| --- | --- | --- |
| **Circle Gateway** | `src/gateway-bridge.ts` | Deposit into a Gateway balance, wait for finality, sign a burn intent, mint on Arc |

Ends with **you** submitting the mint transaction on Arc yourself. No third-party bridge holds your funds, and no relayer is trusted with your money.

---

## Table of contents

- [How the Gateway route works](#how-the-gateway-route-works)
- [Safety first](#safety-first)
- [Setup for beginners](#setup-for-beginners)
  - [1. Install Node.js](#1-install-nodejs)
  - [2. Install VS Code](#2-install-vs-code)
  - [3. Install Git](#3-install-git)
  - [4. Get the code](#4-get-the-code)
  - [5. Install dependencies](#5-install-dependencies)
  - [6. Create your .env file](#6-create-your-env-file)
- [Running it](#running-it)
- [The Arc mainnet flag](#the-arc-mainnet-flag)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)

---

## How the Gateway route works

```
Base USDC
   |
   |  1. approve + deposit(USDC, amount)  -> GatewayWallet on Base
   |     Funds are still YOURS. Nothing is burned. availableBalance() reads them back.
   v
   |  2. Wait ~13-19 min for Circle to index the deposit.
   |     The chain shows your balance immediately; Circle's API shows 0 until
   |     finality passes. Both are correct — this is reorg protection.
   v
   |  3. Sign an EIP-712 BurnIntent off-chain. Free, no gas.
   |     "Burn this much of my Base Gateway balance, mint it to me on Arc."
   v
   |  4. POST it to Circle. They return an attestation (a signed permission
   |     slip). Flat fee, ~0.01 USDC. The attestation expires in ~10 minutes.
   v
   |  5. YOU call gatewayMint(attestation, signature) on Arc.
   |     Circle does not do this for you.
   v
USDC on Arc
```

**The single biggest gotcha:** Arc pays gas in USDC. So step 5 needs you to already hold USDC on Arc in order to receive USDC on Arc. Fund that wallet with a small amount of Arc USDC before you start, or your valid attestation will expire unredeemed. The script checks this before minting and tells you if you're short.

---

## Setup for beginners

Never used a terminal? This section assumes nothing. Total time ~10 minutes.

### 1. Install Node.js

Node runs the scripts. **Version 20.12 or newer is required** (the scripts use Node's built-in `.env` loading).

- Go to **[nodejs.org](https://nodejs.org)** and download the **LTS** version.
- Run the installer, accepting all defaults.
- Verify it worked. Open a terminal:
  - **Windows:** press `Win`, type `powershell`, hit Enter
  - **macOS:** press `Cmd+Space`, type `terminal`, hit Enter
  - **Linux:** `Ctrl+Alt+T`

  Then type:

  ```bash
  node --version
  ```

  You should see something like `v22.11.0`. If you see "command not found", restart your terminal — the installer needs a fresh session to be picked up.

### 2. Install VS Code

VS Code is a free code editor. You don't strictly need it — everything here runs in a terminal — but it makes editing `.env` and reading the scripts much easier.

- Download from **[code.visualstudio.com](https://code.visualstudio.com)** and install.
- Open it, and install one extension: click the **Extensions** icon in the left sidebar (four squares), search for **"TypeScript"**, and confirm the built-in support is enabled. VS Code ships TypeScript support by default, so usually there's nothing to do.
- VS Code has a built-in terminal: **View -> Terminal**, or `` Ctrl+` ``. You can run every command in this README there instead of a separate terminal window.

### 3. Install Git

Git downloads the code and, later, publishes your own changes.

- **Windows:** [git-scm.com/download/win](https://git-scm.com/download/win), install with defaults
- **macOS:** already installed, or run `xcode-select --install`
- **Linux:** `sudo apt install git`

Verify:

```bash
git --version
```

### 4. Get the code

In your terminal, choose where the project should live and clone it:

```bash
cd ~/Desktop
git clone https://github.com/trenchdiver/arc-bridge.git
cd arc-bridge
```

Replace `trenchdiver/arc-bridge` with the actual repo path. Every command from here on assumes you're **inside the `arc-bridge` folder** — that's what `cd arc-bridge` did.

To open the project in VS Code:

```bash
code .
```

(If `code` isn't found, open VS Code and use **File -> Open Folder** instead.)

### 5. Install dependencies

```bash
npm install
```

This reads `package.json` and downloads [viem](https://viem.sh) (the Ethereum library) and [tsx](https://tsx.is) (runs TypeScript without a separate compile step) into a `node_modules` folder. Takes 30 seconds or so. You only do this once.

### 6. Create your .env file

`.env` holds your settings and your private key. Copy the template:

```bash
cp .env.example .env
```

Windows PowerShell: `copy .env.example .env`

Now open `.env` in VS Code and fill it in.

```
PRIVATE_KEY=0xyour_actual_private_key
AMOUNT_USDC=2
NETWORK=mainnet
```

Every other variable is documented inline in the file with its default.

---

## Running it

The Gateway flow is split into three commands because of the finality wait. You can close your terminal between them — progress is tracked in `.gateway-state.json`.

```bash
# Step 1 — deposit on Base
npm run deposit

# Step 2 — watch the finality countdown (13-19 min)
npm run wait

# Steps 3-5 — sign, get the attestation, mint on Arc
npm run transfer
```

Or run all of it in one go, leaving the terminal open for the whole wait:

```bash
npm run bridge
```

Two helper commands:

```bash
# Confirm a deposit landed and recover its transaction hash
npm run check

# Resume the countdown anchored to a specific deposit
# (note the -- before the hash: npm needs it to pass arguments through)
npm run wait -- 0xyourDepositTxHash
```

### What a successful run looks like

```
[1/5] Depositing 2.05 USDC into GatewayWallet on Base
      deposit tx: 0xa1b2...
      landed in Base block 49282467 — finality clock starts here

[2/5] Waiting for Circle to index the deposit (needs 2.05 USDC available)
      deposit landed: 14:32:08 (Base block 49282467)
      [+2m30s | 75 Base blocks] indexed: 0.00/2.05 USDC — ~10m30s-16m30s left
      [+14m00s | 420 Base blocks] indexed: 2.05/2.05 USDC — up to ~5m00s left
      Deposit finalized and indexed after 14m00s.

[3/5] Signing EIP-712 burn intent (off-chain, free)
[4/5] Requesting attestation from Circle
      attestation received (expires in ~10 minutes — mint promptly)
[5/5] Submitting gatewayMint on Arc — Circle does NOT do this for you
      mint tx: 0x5e57... (status: success)
```

The countdown is anchored to the **deposit block's timestamp**, not to when you started the script — so it stays accurate even if you come back to it an hour later.

---

## The Arc mainnet flag

Gateway transfers into Arc mainnet are gated behind an undocumented request header, which this script sends by default:

```
X-ARC-PRIVATE-MAINNET-ENABLED: true
```

Without it, `POST /v1/transfer` returns:

```json
{"success":false,"message":"No active mainnet network found for domain 26"}
```

**Treat this as unstable.** It isn't in Circle's public API documentation, and at the time of writing Circle's own published tooling still lists Arc under testnet only. It's a staged-rollout flag, which means it can change behaviour or stop working without notice, and it may not be intended for general use.

If you'd rather not send it, delete the two lines setting it inside `gatewayHeaders()` in `src/gateway-bridge.ts`. You can add any other headers via `GW_EXTRA_HEADERS` in `.env` without touching the code.

---


## Reference

### Contracts

Gateway and CCTP v2 use the **same addresses on every EVM chain**.

| Contract | Address |
| --- | --- |
| GatewayWallet (mainnet) | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| GatewayMinter (mainnet) | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| GatewayWallet (testnet) | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| GatewayMinter (testnet) | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| CCTP v2 TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP v2 MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |

### Tokens and chains

| | Base | Arc |
| --- | --- | --- |
| Circle domain | 6 | 26 |
| Chain ID (mainnet) | 8453 | 5042 |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x3600000000000000000000000000000000000000` |
| Gas token | ETH | **USDC** |
| Explorer | basescan.org | explorer.arc.io |

Arc's USDC is a predeploy that doubles as the gas token. Note that Arc's `eth_getBalance` returns 18-decimal units even though USDC is a 6-decimal token — a raw balance of `1000000000000000000` is **1 USDC**, not 1e12.

### Repo layout

```
arc-bridge/
├── src/
│   ├── gateway-bridge.ts   # Gateway route (deposit / wait / transfer / all)
│   └── check-deposit.ts    # verify a deposit landed, recover its tx hash
├── .env.example            # template — copy to .env
├── .gitignore              # keeps .env out of git
├── package.json            # dependencies + npm run shortcuts
└── tsconfig.json           # TypeScript settings
```

---

## Troubleshooting

### `Cannot find module 'viem/accounts'`

Your `tsconfig.json` is using legacy module resolution, which can't read the `exports` map that viem uses for subpaths. The included `tsconfig.json` already sets `"moduleResolution": "bundler"`, so if you're seeing this, you're either in a different project or your editor cached the error. Restart the TS server: `Cmd/Ctrl+Shift+P` -> **TypeScript: Restart TS Server**.

### `ERC20: transfer amount exceeds allowance` — right after a successful approve

An RPC race, not a real allowance problem. Public RPCs load-balance across nodes, and the node simulating your deposit hadn't yet seen the block containing your approval. The script now waits for the allowance to become visible, but if it still happens, **just re-run the command** — the approval is on-chain, so the second run skips it. Setting `BASE_RPC_URL` to a dedicated endpoint prevents it entirely.

### `Block at number "..." could not be found`

Same root cause: a lagging RPC node. This is now non-fatal — the script retries, then falls back to your local clock for the countdown. **If you hit this on an older version during a deposit, do not re-run `npm run deposit`** — your deposit likely succeeded and re-running would deposit a second time. Run `npm run check` to confirm, then resume with `npm run wait -- 0xyourDepositTxHash`.

### `No active mainnet network found for domain 26`

Arc mainnet isn't enabled for your request. See [The Arc mainnet flag](#the-arc-mainnet-flag).

### `/transfer rejected: required 10.01`

Your Gateway balance doesn't cover the amount **plus** Circle's flat fee. The number in the error message is exactly what's needed. Raise `MAX_FEE_USDC` and deposit again, or lower `AMOUNT_USDC`.

### Circle's API says my balance is 0 but the chain shows it

Expected during the finality window. Circle won't attest against a deposit that could still be reorged out. `npm run wait` shows the countdown.

### Zero gas on Arc / the mint fails

You need USDC on Arc to pay for the transaction that delivers your USDC on Arc. Fund the wallet with a small amount first. With Gateway, the attestation expires in ~10 minutes, so fix this **before** running `transfer`.

### Something else

Run with more detail and check the transaction on the relevant explorer:

```bash
npx tsx src/gateway-bridge.ts transfer
```

The full error object includes the contract, function, and arguments that failed.

---

## License

MIT — see [LICENSE](LICENSE). Update the copyright line with your name before publishing.
