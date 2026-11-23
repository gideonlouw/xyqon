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

## Signed Releases

Official releases provide Windows and Linux binaries with four files per platform:

- the executable
- a `.sha256` checksum
- a Sigstore `.sig` signature
- a Sigstore `.pem` signing certificate

Download them from [GitHub Releases](https://github.com/gideonlouw/xyqon/releases).

Check the downloaded checksum:

```bash
sha256sum --check xyqon-v0.3.0-linux-x86_64.sha256
```

Verify the keyless GitHub Actions signature with Cosign:

```bash
cosign verify-blob \
  --certificate xyqon-v0.3.0-linux-x86_64.pem \
  --signature xyqon-v0.3.0-linux-x86_64.sig \
  --certificate-identity-regexp '^https://github.com/gideonlouw/xyqon/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  xyqon-v0.3.0-linux-x86_64
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

Show the installed node and network protocol versions:

```bash
xyqon version
```

Version 0.3.0 reports protocol 3 and activates permissionless mining at block **270**.
Blocks below 270 still use the historical miner rules. From block 270, miners can
use their own reward wallet without registration or a public listening address.
Proof of work, transaction validation, and reward limits still apply.

Upgrade all nodes and miners before block 270. Stop the existing 0.2.0 services
before bringing the upgraded peers online: old builds can stop validation after
seeing two trusted peers report a higher protocol. Version 0.3.0 only logs an
upgrade notice. Keep the current chain, wallet, peer, and historical miner files.

## Peer List

Nodes can load known peers from a newline-separated file. Each line may contain either an IP address or an `IP:PORT` address. If no port is supplied, XYQON uses port `7101`.

Example `peers.txt`:

```text
143.244.149.8:7101
68.183.98.134:7101
147.182.138.183:7101
```

Start a node with the file:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

When a node starts with `--advertise`, it announces that public address to the peers it already knows. Peers that receive the announcement validate the address and check that the announced server responds like a XYQON peer before saving it or forwarding it.

This means a new node joins by:

1. Adding at least one existing public node to its peer file.
2. Starting with `--peers-file`.
3. Starting with `--advertise NEW_NODE_PUBLIC_IP:7101`.

Do not add public DNS servers, test IPs, or unrelated hosts such as `1.1.1.1:7101` or `8.8.8.8:7101` to `peers.txt`. A peer should be a reachable XYQON node listening on TCP port `7101`.

The addresses above are bootstrap peers. You can use any reachable XYQON node
as a seed or share your own independently operated seed. Preserve historical
miner mappings in `deploy/trusted-miners.example.json` and any additional
mappings required to validate blocks before height 270.

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
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The node keeps running, accepts valid blocks and transactions, syncs from known peers, and updates the peer file when new nodes announce themselves.

## Join The Network

Create or edit `/etc/xyqon/peers.txt` on the new server:

```text
143.244.149.8:7101
68.183.98.134:7101
147.182.138.183:7101
```

Start the new node:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise NEW_NODE_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

On startup, the joining node requests chains from known peers and adopts a valid chain with more accumulated work. It also announces its own public address so other running nodes can discover it.

Use this flow for a new relay node first. After it is reachable and visible to the existing network, decide separately whether it should become a public miner.

## Mine Without Registration

Once the chain reaches block 269, the next block is open to any miner running
0.3.0 or later. Create a wallet, point the miner at reachable peers, and run:

```bash
xyqon mine --peers-file /etc/xyqon/peers.txt --wallet miner.wallet.json
```

For incoming peer connections, add a listener and advertise a reachable address.
Use a chain path and wallet path appropriate to your installation. Keep the
historical trusted miner file if your network uses additional historical mappings.

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
Updated nodes reply to transaction submissions with `pending`, `confirmed`, or `rejected` so clients can detect rejected transactions immediately.

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

For production NFTs, first register the collection with `xyqon-client`. Registered collections
record their creator, metadata URL, authorized minters, mutability, and permanent lock state
on-chain. Once registered, nodes reject mints from wallets outside the authorized list. Existing
unregistered collections remain supported for live-chain compatibility.

Deploy the updated node binary to every XYQON server before submitting the first collection
registration transaction. Older nodes cannot decode the new asset-operation variants.

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
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --wallet miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The miner keeps syncing with peers and includes valid pending transactions when available. The reward goes to the miner whose block is accepted.

Version 0.5.0 is scheduled to activate continuous mining on **25 November 2026 at 00:00 UTC (02:00 SAST)**. From activation, miners can produce coinbase-only blocks when the mempool is empty, so earlier payments can gain confirmations during quiet periods. The 60-second difficulty target is an average target. Upgrade all nodes and miners before activation because older nodes reject the new coinbase-only blocks. Rehearse the upgrade on an isolated copy of the chain before rolling it out.

Version 0.5.0 (protocol 5) saves new blocks to an append-only journal named `<chain>.blocks.jsonl` beside the existing chain snapshot. The node opens existing snapshots directly and creates the journal on the next chain update. Back up and restore the snapshot and its journal together. Use one running node or miner per chain path.

Protocol 5 peers synchronize from their newest shared ancestor in batches of up to 128 blocks. Peers advertising older protocol versions still use whole-chain synchronization. The journal retains history, including superseded blocks after a reorganization, and does not prune old data.

Version 0.6.0 (protocol 6) selects the chain with the greatest cumulative expected hashing work. For each required hexadecimal zero, a block contributes 16 times as much work. The lower tip hash still breaks exact work ties. Existing block hashes, transaction formats, and the mining target are compatible with this change. The new scoring rule takes effect when the upgraded binary starts, so coordinate the upgrade across all operators. Follow the [chain selection upgrade steps](docs/linux-live.md#upgrade-chain-selection-to-protocol-6).

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
RequestTransaction(String)
TransactionResponse(TransactionStatus)
```

When a node receives a peer announcement, it validates the address format and checks that the peer answers XYQON network requests before saving or forwarding the address. This prevents unrelated hosts from polluting `peers.txt`.
Dashboards and other tools can also request a node's known peers with `RequestPeers`, then crawl from those seed nodes to discover more of the network.

When a node receives a transaction, it checks the signature, rejects invalid spends, stores valid transactions in its mempool, replies with the transaction status, and shares accepted transactions with peers. Transactions are checked against confirmed balances plus pending spends.

When a node receives a block, it checks:

- The block index is the next expected index
- The previous hash links to the local chain tip
- The proof-of-work hash is valid
- The difficulty is correct for the active block target
- The first transaction is the correct coinbase reward for that block height
- The total coin supply does not exceed 67,000,000 XYQON
- Every normal transaction signature is valid
- Every normal transaction has enough confirmed balance to spend
- Historical miner rewards follow the allowlist rules before height 270

If the block is accepted, the node appends it to its local chain, saves it, removes confirmed transactions from the mempool, and shares the block with known peers.

## Current Operational Notes

- Keep `/etc/xyqon/peers.txt` writable by the `xyqon` service user so discovered peers can be saved.
- Keep public node `peers.txt` files clean. They should contain only reachable XYQON nodes.
- If an invalid peer or invalid public miner reward enters the network, stop miners, clean `peers.txt`, roll back to the last shared valid block, clear mempools, redeploy the patched binary, and restart from the clean chain.
- Wallet files are plain JSON and are not encrypted.
- `node` does not mine. Use `submit` to send funds and `mine` to compete for rewards.
- The mempool is persisted to disk and reloaded on startup.
