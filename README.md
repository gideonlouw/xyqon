# XYQON

XYQON is a small Rust blockchain project with:

- Proof-of-work blocks
- Signed Ed25519 transactions
- Coinbase mining rewards
- 67 million maximum coin supply
- Dynamic mining difficulty targeting 30-second blocks
- Mempool for pending signed transactions
- Chain sync for late-joining peers
- Fork resolution using accumulated work
- Balance validation to reject overspending
- JSON wallet files
- TCP peer-to-peer block sharing

## Requirements

- Rust and Cargo
- A terminal with access to the project folder

Check that Rust is installed:

```powershell
rustc --version
cargo --version
```

## Build

```powershell
cargo build
```

If your normal `target` folder is locked by Windows, use a separate build folder:

```powershell
cargo build --target-dir target-codex
```

## Linux Server Deployment

For public Linux node setup, firewall configuration, and systemd service instructions, see:

[docs/linux-live.md](docs/linux-live.md)

## CLI Overview

```powershell
cargo run -- help
```

The app has two main command groups:

- `node`: run a blockchain node
- `wallet`: create or inspect wallet keys

## Create A Wallet

Create a wallet for Alice:

```powershell
cargo run -- wallet new --name Alice --out alice.wallet.json
```

Create a wallet for Bob:

```powershell
cargo run -- wallet new --name Bob --out bob.wallet.json
```

Wallet files contain both public and private keys. Keep private keys secret and do not commit wallet files to Git.

## Export Wallet Keys

Show the wallet name and public key:

```powershell
cargo run -- wallet export --wallet alice.wallet.json
```

Show the private key too:

```powershell
cargo run -- wallet export --wallet alice.wallet.json --show-private
```

## Check Wallet Balance

Balances are calculated from the saved chain file. The default chain file is `xyqon-chain.json`.

```bash
xyqon wallet balance --wallet miner.wallet.json
```

Use `--chain` if your node writes to a custom chain file:

```bash
xyqon wallet balance --wallet miner.wallet.json --chain /var/lib/xyqon/xyqon-chain.json
```

## Run A Node

Start a node that listens for peer blocks:

```powershell
cargo run -- node --listen 127.0.0.1:7101
```

The node keeps running and waits for other peers to send valid blocks.
On a public Linux server, listen on all interfaces:

```bash
xyqon node --listen 0.0.0.0:7101
```

By default, accepted blocks are saved to:

```text
xyqon-chain.json
```

Use a custom storage path with:

```bash
xyqon node --listen 0.0.0.0:7101 --chain /var/lib/xyqon/xyqon-chain.json
```

## Join A Peer

Open a second terminal and run another node that connects to the first node:

```powershell
cargo run -- node --listen 127.0.0.1:7102 --peer 127.0.0.1:7101
```

You can add more peers by repeating `--peer`:

```powershell
cargo run -- node --listen 127.0.0.1:7103 --peer 127.0.0.1:7101 --peer 127.0.0.1:7102
```

When a node starts with peers, it requests their chain and adopts a better valid chain if one is available.

## Mine And Share A Signed Transaction

Run a node that loads a wallet and mines the first block. If you omit `--to`, the block contains only the coinbase reward and pays the first `10.0 XYQON` to your wallet public key:

```bash
xyqon node --listen 0.0.0.0:7101 --wallet miner.wallet.json
```

To also create a signed transaction at startup, add `--to` and `--amount`. The transaction is placed into the mempool, then mined into the block:

```powershell
cargo run -- node --listen 127.0.0.1:7102 --peer 127.0.0.1:7101 --wallet alice.wallet.json --to Bob --amount 25
```

The miner receives a coinbase reward transaction in the mined block. The current reward is:

```text
10.0 XYQON initially
```

The reward halves every 100,000 mined blocks:

```text
Blocks 1 - 100,000:       10.0 XYQON
Blocks 100,001 - 200,000: 5.0 XYQON
Blocks 200,001 - 300,000: 2.5 XYQON
```

When mining with `--wallet`, the reward is paid to that wallet's public key.

Mining difficulty adjusts dynamically to target one block every 30 seconds:

```text
Faster than 30 seconds: difficulty increases by 1
Exactly 30 seconds:    difficulty stays the same
Slower than 30 seconds: difficulty decreases by 1, down to a minimum of 1
```

Each block stores the difficulty it was mined with, and nodes verify that the difficulty matches the expected value before accepting the block.

The total supply is capped at:

```text
67,000,000 XYQON
```

Nodes reject locally mined or peer-received blocks if the coinbase reward would push total issued supply above that cap.
Each node tracks circulating supply from accepted coinbase transactions and prints it with the chain.
If the remaining supply is smaller than the scheduled reward, the only valid coinbase reward is the remaining supply.
Once circulating supply reaches 67,000,000 XYQON, no more mining rewards can be minted.

If the peer accepts the block, it prints:

```text
Accepted block 1 from peer
```

The local node also prints the number of pending transactions left in the mempool after mining.

## Demo Mining

For a quick test without creating a wallet first:

```powershell
cargo run -- node --listen 127.0.0.1:7102 --peer 127.0.0.1:7101 --mine-demo
```

## How Block Sharing Works

Nodes send one JSON message per line over TCP:

```text
NewBlock(Block)
NewTransaction(Transaction)
```

When a node receives a transaction, it checks the signature, rejects duplicates, stores the transaction in its mempool, and shares it with its configured peers.
Transactions are also checked against confirmed balances plus already pending spends, so wallets cannot queue transactions that overspend available funds.

When a node receives a block, it checks:

- The block index is the next expected index
- The previous hash links to the local chain tip
- The proof-of-work hash is valid
- The difficulty is correct for the 30-second block target
- The first transaction is the correct coinbase reward for that block height
- The total coin supply does not exceed 67,000,000 XYQON
- The coinbase reward does not exceed the remaining unissued supply
- Every normal transaction signature is valid
- Every normal transaction has enough confirmed balance to spend

If the block is accepted, the node appends it to its local chain and shares it with its configured peers.
Transactions included in accepted blocks are removed from the local mempool.

If a peer returns a valid chain with more accumulated work than the local chain, the node adopts that chain and saves it.

## Current Limitations

- There is no automatic peer discovery yet
- Wallet files are plain JSON and not encrypted
- Each CLI startup can mine one transaction, then the node continues listening
- The mempool is in memory only and is lost when the node exits

## Suggested Next Steps

- Add persistent mempool storage
- Add automatic peer discovery
- Encrypt wallet private keys with a passphrase
