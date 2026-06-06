# XYQON

XYQON is a Rust blockchain node with:

- Proof-of-work blocks
- Signed Ed25519 transactions
- Coinbase mining rewards
- 67 million maximum coin supply
- Rolling-window mining difficulty targeting 60-second blocks
- Persistent mempool for pending signed transactions
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

The app has these command groups:

- `node`: run a blockchain node
- `submit`: sign and broadcast a transaction without mining
- `coin`: create a basic coin on top of XYQON
- `nft`: mint and transfer game NFTs on top of XYQON
- `mine`: run a miner that competes for block rewards
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

## Submit A Transaction

Use `submit` to sign and broadcast a transaction without mining a block. This lets a normal wallet send funds without automatically receiving the next mining reward.

```bash
xyqon submit \
  --peers-file /etc/xyqon/peers.txt \
  --wallet miner.wallet.json \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 1 \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The transaction enters the mempool of reachable peers. A miner must then include it in a block.

## Create A Coin

Use `coin create` to define a basic fixed-supply coin on top of the XYQON network. Coin creation is a signed `0 XYQON` transaction, so the creator does not need to spend XYQON to submit it. When a miner includes the transaction in a block, the creator receives the full initial supply and the miner receives the normal XYQON block reward.

```bash
xyqon coin create \
  --peers-file /etc/xyqon/peers.txt \
  --wallet creator.wallet.json \
  --symbol GAME \
  --name "Game Coin" \
  --supply 1000000 \
  --chain /var/lib/xyqon/xyqon-chain.json
```

Coin symbols are unique across the chain and may contain 2 to 12 letters or numbers. The initial supply is fixed forever; there is no later mint transaction.

Use `coin send` to transfer that token between wallets. Token transfers are also signed `0 XYQON` transactions, and miners earn the normal XYQON block reward for including them.

```bash
xyqon coin send \
  --peers-file /etc/xyqon/peers.txt \
  --wallet creator.wallet.json \
  --symbol GAME \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 25 \
  --chain /var/lib/xyqon/xyqon-chain.json
```

## Mint An NFT

Use `nft mint` to mint a unique game item or collectible on XYQON. NFT minting is a signed `0 XYQON` transaction. The optional image URL points to external artwork, keeping the blockchain focused on ownership and metadata instead of storing image data.

```bash
xyqon nft mint \
  --peers-file /etc/xyqon/peers.txt \
  --wallet player.wallet.json \
  --collection GAMEITEMS \
  --token-id sword-001 \
  --name "Iron Sword" \
  --image-url https://example.com/game-assets/iron-sword.png \
  --chain /var/lib/xyqon/xyqon-chain.json
```

Use `nft send` to transfer the NFT to another wallet:

```bash
xyqon nft send \
  --peers-file /etc/xyqon/peers.txt \
  --wallet player.wallet.json \
  --collection GAMEITEMS \
  --token-id sword-001 \
  --to RECIPIENT_PUBLIC_KEY \
  --chain /var/lib/xyqon/xyqon-chain.json
```

An NFT id can only be minted once per collection. Only the current owner can transfer it.

## Run A Miner

Use `mine` only on nodes that should compete for block rewards:

```bash
xyqon mine \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --wallet miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The miner keeps syncing with peers, relays valid network messages, and tries to mine when transactions are waiting. The reward goes to whichever miner finds and broadcasts the accepted block. Mined blocks must include at least one normal transaction.

The default mempool file is based on the chain path:

```text
/var/lib/xyqon/xyqon-chain.json.mempool.json
```

Use `--mempool <FILE>` on `node`, `submit`, or `mine` if you want a custom mempool path.

The reward starts at `10.0 XYQON` and halves every `100,000` mined blocks. Total supply is capped at `67,000,000 XYQON`.

## How Block Sharing Works

Nodes send one JSON message per line over TCP:

```text
NewBlock(Block)
NewTransaction(Transaction)
NewPeer(String)
RequestChain
ChainResponse(Blockchain)
RequestPeers
PeerResponse(Vec<String>)
```

When a node receives a peer announcement, it validates the address format, adds the peer if it is new, saves it to the configured peer file, and forwards the announcement to known peers.
Dashboards and other tools can also request a node's known peers with `RequestPeers`, then crawl from those seed nodes to discover more of the network.

When a node receives a transaction, it checks the signature, rejects duplicates, stores the transaction in its mempool, and shares it with peers. Transactions are checked against confirmed balances plus pending spends.

When a node receives a block, it checks:

- The block index is the next expected index
- The previous hash links to the local chain tip
- The proof-of-work hash is valid
- The difficulty is correct for the active block target
- The first transaction is the correct coinbase reward for that block height
- The total coin supply does not exceed 67,000,000 XYQON
- Every normal transaction signature is valid
- Every normal transaction has enough confirmed balance to spend

If the block is accepted, the node appends it to its local chain, saves it, removes confirmed transactions from the mempool, and shares the block with known peers.

## Current Operational Notes

- Keep `/etc/xyqon/peers.txt` writable by the `xyqon` service user so discovered peers can be saved.
- Wallet files are plain JSON and are not encrypted.
- `node` does not mine. Use `submit` to send funds and `mine` to compete for rewards.
- The mempool is persisted to disk and reloaded on startup.
