# XYQON Dashboard

Angular dashboard for the live XYQON network.

It shows:

- Live node reachability
- Current block height and circulating supply
- Public addresses seen on-chain
- Rich list sorted by balance
- Coins and holders seen on-chain
- NFTs and current owners seen on-chain
- Recent blocks
- Recent transactions
- Explorer search for addresses, blocks, and transactions

The browser app calls a local Node API proxy because browsers cannot speak XYQON's TCP protocol directly.

## Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:4200
```

## Configure Nodes

Edit `peers.txt` and add one or more seed nodes:

```text
68.183.98.134
143.244.149.8
147.182.138.183
```

The dashboard uses these as seed nodes only. On each refresh, it asks reachable nodes for their known peers, checks the discovered nodes too, and saves the expanded list back into `peers.txt`.

You can also point the API at another peer file:

```bash
XYQON_PEERS_FILE=/etc/xyqon/peers.txt npm start
```

To disable saving discovered peers back to the file:

```bash
XYQON_DASHBOARD_SAVE_PEERS=false npm start
```

## Local API

The local API proxy exposes:

```text
/api/dashboard
/api/address/<PUBLIC_KEY>
/api/block/<HEIGHT_OR_HASH>
/api/transaction/<TRANSACTION_ID>
/api/assets
```
