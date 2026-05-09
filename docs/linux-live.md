# Running XYQON On A Linux Server

This guide shows how to run XYQON as a public Linux node.


## 1. Rent A Server

A small Ubuntu LTS server is enough for early testing:

- Ubuntu 22.04 or 24.04 LTS
- 1 CPU
- 1 GB RAM or more
- Public IPv4 address
- SSH access

This guide uses port `7101`.

## 2. Install Server Packages

SSH into the server:

```bash
ssh root@YOUR_SERVER_IP
```

Install base tools:

```bash
apt update
apt install -y build-essential curl git ufw
```

Install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

## 3. Clone And Build

```bash
git clone https://github.com/gideonlouw/xyqon.git /opt/xyqon
cd /opt/xyqon
cargo build --release
```

Install the node binary:

```bash
cp target/release/xyqon /usr/local/bin/xyqon
xyqon help
```

## 4. Open The Firewall

```bash
ufw allow OpenSSH
ufw allow 7101/tcp
ufw enable
ufw status
```

Your cloud provider may also have a firewall/security group. Open TCP port `7101` there too.

## 5. Create A Node User

```bash
useradd --system --home /opt/xyqon --shell /usr/sbin/nologin xyqon
mkdir -p /var/lib/xyqon
chown -R xyqon:xyqon /opt/xyqon
chown -R xyqon:xyqon /var/lib/xyqon
```

## 6. Run A Public Seed Node

For the first public node:

```bash
xyqon node --listen 0.0.0.0:7101
```

Use `0.0.0.0` on Linux when you want the node to accept public connections.

## 7. Run As A Service

Copy the example service:

```bash
cp /opt/xyqon/deploy/xyqon.service.example /etc/systemd/system/xyqon.service
systemctl daemon-reload
systemctl enable xyqon
systemctl start xyqon
systemctl status xyqon
```

View logs:

```bash
journalctl -u xyqon -f
```

## 8. Join From Another Server

On another Linux server:

```bash
xyqon node --listen 0.0.0.0:7101 --peer YOUR_SEED_NODE_IP:7101
```

On startup, the joining node requests the seed node's chain and adopts it if it is valid and has more accumulated work.

If the peer receives and accepts blocks, it will print messages like:

```text
Accepted block 1 from peer
```

## 9. Create A Wallet

```bash
xyqon wallet new --name MinerOne --out miner.wallet.json
chmod 600 miner.wallet.json
```

Show the public key:

```bash
xyqon wallet export --wallet miner.wallet.json
```

Keep `miner.wallet.json` private. Do not commit wallet files to Git.

## 10. Mine The First Reward Block

To mine the first block and pay the first `10.0 XYQON` coinbase reward to your wallet public key:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --wallet miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

The first non-genesis block will contain a coinbase transaction:

```text
sender: "network"
recipient: <your wallet public key>
amount: 10.0
```

You should also see:

```text
Circulating supply: 10 / 67000000 XYQON
Is blockchain valid? true
```

Check your saved balance:

```bash
xyqon wallet balance \
  --wallet miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

## 11. Mine A Transaction

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --peer PEER_IP:7101 \
  --wallet miner.wallet.json \
  --to Bob \
  --amount 1
```

The signed transaction enters the mempool, is mined into a block, and then the block is shared with peers.

## 12. Suggested Public Testnet Rollout

1. Start one seed node.
2. Start a second node on another server and connect it to the seed.
3. Mine a test transaction and confirm the other node accepts the block.
4. Add two or three more peers.
5. Keep this as a testnet while peer discovery, wallet encryption, monitoring, and security review are still outstanding.

## Current Go-Live Blockers

These are the big items before this can responsibly handle real value:

- Encrypted wallet private keys
- Mempool persistence and transaction expiry
- Peer discovery and peer banning/rate limiting
- TLS or authenticated transport
- Automated backups and monitoring
- Security review
