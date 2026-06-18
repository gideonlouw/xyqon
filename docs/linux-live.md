# Running XYQON On A Linux Server

This guide shows how to run XYQON as a public Linux node.

The public node port used here is `7101`.

## 1. Server Requirements

- Ubuntu 22.04 or 24.04 LTS
- 1 CPU
- 1 GB RAM or more
- Public IPv4 address
- SSH access

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

Your cloud provider may also have a firewall/security group. Open inbound TCP port `7101` there too.

## 5. Create The Node User And Data Folders

```bash
useradd --system --home /opt/xyqon --shell /usr/sbin/nologin xyqon
mkdir -p /var/lib/xyqon /etc/xyqon
chown -R xyqon:xyqon /opt/xyqon
chown -R xyqon:xyqon /var/lib/xyqon /etc/xyqon
```

## 6. Create The Peer File

Create `/etc/xyqon/peers.txt` with known public nodes. Each line may contain either an IP address or `IP:PORT`. If the port is omitted, XYQON uses `7101`.

```bash
cat >/etc/xyqon/peers.txt <<'EOF'
68.183.98.134
143.244.149.8
EOF
chown xyqon:xyqon /etc/xyqon/peers.txt
chmod 664 /etc/xyqon/peers.txt
```

On a new node, include at least one existing reachable node in this file. The new node will announce itself to those peers when it starts.

Create the trusted miner file from the packaged example:

```bash
cp /opt/xyqon/deploy/trusted-miners.example.json /etc/xyqon/trusted-miners.json
chown xyqon:xyqon /etc/xyqon/trusted-miners.json
chmod 664 /etc/xyqon/trusted-miners.json
```

## 7. Start A Public Node Manually

Replace `YOUR_SERVER_IP` with the server's public IPv4 address:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_SERVER_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

Use `0.0.0.0` for `--listen` so the node accepts public connections. Use the public IP for `--advertise` so other nodes know how to connect back to this node.

## 8. Run As A Service

Copy the example service:

```bash
cp /opt/xyqon/deploy/xyqon.service.example /etc/systemd/system/xyqon.service
```

Edit the service and replace `YOUR_SERVER_IP`:

```bash
nano /etc/systemd/system/xyqon.service
```

Enable and start the service:

```bash
systemctl daemon-reload
systemctl enable xyqon
systemctl restart xyqon
systemctl status xyqon
```

View logs:

```bash
journalctl -u xyqon -f
```

Confirm the node is listening:

```bash
ss -ltnp | grep 7101
```

## 9. Join As A New Node

On the new server:

1. Build and install `xyqon`.
2. Open TCP port `7101` in `ufw` and the cloud firewall.
3. Add one or more existing public nodes to `/etc/xyqon/peers.txt`.
4. Start the node with `--advertise NEW_NODE_PUBLIC_IP:7101`.

Example:

```bash
xyqon node \
  --listen 0.0.0.0:7101 \
  --advertise NEW_NODE_PUBLIC_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

What happens next:

- The new node reads `/etc/xyqon/peers.txt`.
- It requests the current chain from known peers.
- It adopts a valid chain if that chain has more accumulated work.
- It announces `NEW_NODE_PUBLIC_IP:7101` to known peers.
- Running peers save the new address into their own peer file and forward it to the peers they know.

## 10. Create A Wallet

```bash
xyqon wallet new --name MinerOne --out /var/lib/xyqon/miner.wallet.json
chown xyqon:xyqon /var/lib/xyqon/miner.wallet.json
chmod 600 /var/lib/xyqon/miner.wallet.json
```

Show the public key:

```bash
xyqon wallet export --wallet /var/lib/xyqon/miner.wallet.json
```

Keep wallet files private.

## 11. Add A Trusted Miner

After the new server has joined as a normal node and synced, run this on an existing trusted server:

```bash
xyqon miner add-trusted \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --peer NEW_NODE_PUBLIC_IP:7101 \
  --wallet NEW_MINER_PUBLIC_WALLET
```

Copy the updated `/etc/xyqon/trusted-miners.json` to every public mining node before the new server starts mining. The command refuses to change the reward wallet for a peer that is already trusted.

Each server writes `/etc/xyqon/trusted-miners.json.lock` after accepting the trusted file. If someone later changes a previously accepted miner wallet or removes a trusted miner from the JSON file, that server rejects the file on startup.

## 12. Run A Miner

```bash
xyqon mine \
  --listen 0.0.0.0:7101 \
  --advertise YOUR_SERVER_IP:7101 \
  --peers-file /etc/xyqon/peers.txt \
  --trusted-miners-file /etc/xyqon/trusted-miners.json \
  --wallet /var/lib/xyqon/miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

Use the `node` service for always-on relay nodes. Use `mine` only on servers that should compete for block rewards. Miners wait for pending transactions, and mined blocks must include at least one normal transaction.

The mempool is persisted beside the chain by default:

```text
/var/lib/xyqon/xyqon-chain.json.mempool.json
```

Check the saved balance:

```bash
xyqon wallet balance \
  --wallet /var/lib/xyqon/miner.wallet.json \
  --chain /var/lib/xyqon/xyqon-chain.json
```

## 13. Submit A Transaction

This signs and broadcasts a transaction without mining a block:

```bash
xyqon submit \
  --peers-file /etc/xyqon/peers.txt \
  --wallet /var/lib/xyqon/miner.wallet.json \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 1 \
  --chain /var/lib/xyqon/xyqon-chain.json
```

## 14. Verify Public Reachability

From your local machine or another server:

```bash
nc -vz 68.183.98.134 7101
nc -vz 143.244.149.8 7101
nc -vz 147.182.138.183 7101
```

If that fails, check:

- `systemctl status xyqon`
- `journalctl -u xyqon -n 80 --no-pager`
- `ss -ltnp | grep 7101`
- `ufw status`
- The cloud firewall/security group inbound rule for TCP `7101`
