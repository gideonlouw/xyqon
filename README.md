# XYQON

XYQON is a Rust blockchain node with:

- Proof-of-work blocks
- Signed Ed25519 transactions
- Coinbase mining rewards
- 67 million maximum coin supply
- Dynamic mining difficulty targeting 30-second blocks
- Mempool for pending signed transactions
- Chain sync for late-joining peers
- Peer discovery through a shared node list and peer announcements
- Fork resolution using accumulated work
- Balance validation to reject overspending
- JSON wallet files
- TCP peer-to-peer block and transaction sharing

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

For Linux server deployment, firewall setup, systemd setup, and joining instructions, see:

[docs/linux-live.md](docs/linux-live.md)

## CLI Overview

```powershell
cargo run -- help
```

The app has two command groups:

- `node`: run a blockchain node
- `wallet`: create or inspect wallet keys

## Peer List

Nodes can load known peers from a newline-separated file. Each line may contain either an IP address or an `IP:PORT` address. If no port is supplied, XYQON uses port `7101`.

Example `peers.txt`:

```text
68.183.98.134
143.244.149.8
```

Start a node with the file:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --chain /var/lib/xyqon/xyqon-chain.json
```

When a node starts with `--advertise`, it announces that public address to the peers it already knows. Peers that receive the announcement add the new address to their in-memory peer list, save it back to their peer file, and forward the announcement to the rest of their known peers.

This means a new node joins by:

1. Adding at least one existing public node to its peer file.
2. Starting with `--peers-file`.
3. Starting with `--advertise NEW_NODE_PUBLIC_IP:7101`.

## Create A Wallet

```powershell
cargo run -- wallet new --name MinerOne --out miner.wallet.json
```

Wallet files contain both public and private keys. Keep private keys secret and do not commit wallet files to Git.

## Export Wallet Keys

```powershell
cargo run -- wallet export --wallet miner.wallet.json
```

Show the private key only when you intentionally need it:

```powershell
cargo run -- wallet export --wallet miner.wallet.json --show-private
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

Start a local node that listens for peers:

```powershell
cargo run -- node --listen 127.0.0.1:7101
```

On a public Linux server, listen on all interfaces and advertise the public address:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise 68.183.98.134:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The node keeps running, accepts valid blocks and transactions, syncs from known peers, and updates the peer file when new nodes announce themselves.

## Join The Network

Create or edit `/etc/xyqon/peers.txt` on the new server:

```text
68.183.98.134
143.244.149.8
```

Start the new node:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise NEW_NODE_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --chain /var/lib/xyqon/xyqon-chain.json
```

On startup, the joining node requests chains from known peers and adopts a valid chain with more accumulated work. It also announces its own public address so other running nodes can discover it.

## Mine And Share A Signed Transaction

Run a node that loads a wallet and mines the next block. If you omit `--to`, the block contains only the coinbase reward and pays the current reward to your wallet public key:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --wallet miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

To also create a signed transaction at startup, add `--to` and `--amount`:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --wallet miner.wallet.json \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 1 \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The reward starts at `10.0 XYQON` and halves every `100,000` mined blocks. Total supply is capped at `67,000,000 XYQON`.

## How Block Sharing Works

Nodes send one JSON message per line over TCP:

```text
NewBlock(Block)
NewTransaction(Transaction)
NewPeer(String)
RequestChain
ChainResponse(Blockchain)
```

When a node receives a peer announcement, it validates the address format, adds the peer if it is new, saves it to the configured peer file, and forwards the announcement to known peers.

When a node receives a transaction, it checks the signature, rejects duplicates, stores the transaction in its mempool, and shares it with peers. Transactions are checked against confirmed balances plus pending spends.

When a node receives a block, it checks:

- The block index is the next expected index
- The previous hash links to the local chain tip
- The proof-of-work hash is valid
- The difficulty is correct for the 30-second block target
- The first transaction is the correct coinbase reward for that block height
- The total coin supply does not exceed 67,000,000 XYQON
- Every normal transaction signature is valid
- Every normal transaction has enough confirmed balance to spend

If the block is accepted, the node appends it to its local chain, saves it, removes confirmed transactions from the mempool, and shares the block with known peers.

## Current Operational Notes

- Keep `/etc/xyqon/peers.txt` writable by the `xyqon` service user so discovered peers can be saved.
- Wallet files are plain JSON and are not encrypted.
- Each CLI startup with `--wallet` mines one block, then the node continues listening.
- The mempool is in memory only and is lost when the node exits.
