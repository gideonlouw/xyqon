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

Peer discovery and mining rewards are separate trust decisions. A discovered node can relay chain and transaction data, but new public miners should be added deliberately. Before allowing a new public server to mine rewards, approve its `IP:PORT` and reward wallet with a current trusted miner wallet so the signed approval can broadcast through the peer network.

Use `deploy/trusted-miners.example.json` as the starting `/etc/xyqon/trusted-miners.json` file for public nodes.

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

## Add A Public Miner

Use `mine` only on servers that should compete for block rewards. Public miner membership is intentionally stricter than peer discovery so invalid announced peers cannot claim mining rewards.

To add a new public miner:

1. Run it as a normal public node first and confirm it responds on `NEW_NODE_PUBLIC_IP:7101`.
2. Confirm its `peers.txt` contains only real XYQON peers.
3. Confirm it has synced to the current valid chain.
4. Ask the operator for the public key that should receive mining rewards.
5. On an existing trusted server, validate and append the miner:

```bash
xyqon miner add-trusted \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --approver-wallet /var/lib/xyqon/miner.wallet.json \
  --peers-file /etc/xyqon/peers.txt \
  --peer NEW_NODE_PUBLIC_IP:7101 \
  --wallet NEW_MINER_PUBLIC_WALLET
```

6. The approving node signs the new mapping and broadcasts it to known peers. Running nodes accept and save it only if it was signed by a current trusted miner wallet.
7. Start the new server with `xyqon mine --advertise NEW_NODE_PUBLIC_IP:7101 --trusted-miners-file /etc/xyqon/trusted-miners.json`.

If a miner reward block advertises an unknown or invalid `miner_peer`, other nodes should reject that chain instead of syncing to it.

The trusted miner file is append-only by default. If an existing peer is already assigned to a reward wallet, `miner add-trusted` refuses to replace that wallet. This protects existing miners from someone changing their payment address in the shared file.

Each server also writes a local `/etc/xyqon/trusted-miners.json.lock` snapshot after loading the trusted file. On later starts, the node rejects the trusted file if a previously accepted peer is missing or has a different reward wallet.

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

The miner keeps syncing with peers, relays valid network messages, and tries to mine when transactions are waiting. The reward goes to whichever miner finds and broadcasts the accepted block. Mined blocks must include at least one normal transaction.

Miners do not create empty reward-only blocks. If logs show `No pending transactions; waiting for work`, submit a signed transaction first; the next block will be mined only when there is work in the mempool.

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
- Public miner reward blocks identify a known public miner peer

If the block is accepted, the node appends it to its local chain, saves it, removes confirmed transactions from the mempool, and shares the block with known peers.

## Current Operational Notes

- Keep `/etc/xyqon/peers.txt` writable by the `xyqon` service user so discovered peers can be saved.
- Keep public node `peers.txt` files clean. They should contain only reachable XYQON nodes.
- If an invalid peer or invalid public miner reward enters the network, stop miners, clean `peers.txt`, roll back to the last shared valid block, clear mempools, redeploy the patched binary, and restart from the clean chain.
- Wallet files are plain JSON and are not encrypted.
- `node` does not mine. Use `submit` to send funds and `mine` to compete for rewards.
- The mempool is persisted to disk and reloaded on startup.
