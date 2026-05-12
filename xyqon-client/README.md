# XYQON Client

Friendly wallet CLI and JavaScript client for the live XYQON network.

It can:

- Generate a new XYQON wallet
- Show your public key
- Check your balance from live public nodes
- Send a signed transaction to the network
- Show currently reachable nodes

You do not need to mine and you do not need to run a full node.

## Install

```bash
npm install -g xyqon-client
```

Or run without installing:

```bash
npx xyqon-client help
```

## Create A Wallet

```bash
xyqon wallet new --name Cathy
```

This creates:

```text
xyqon.wallet.json
```

Keep this file private. It contains your private key.

## Show Your Address

```bash
xyqon wallet show
```

## Check Balance

```bash
xyqon balance
```

Use a custom wallet path:

```bash
xyqon balance --wallet ./cathy.wallet.json
```

## Send XYQON

```bash
xyqon send \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 1
```

The transaction is broadcast to reachable public nodes. A miner must include it in a block before the receiver sees the confirmed balance.

## Show Nodes

```bash
xyqon nodes
```

## Seed Nodes

The package starts with these seed nodes:

```text
68.183.98.134:7101
143.244.149.8:7101
147.182.138.183:7101
```

You can override them:

```bash
xyqon balance --peer 68.183.98.134:7101 --peer 143.244.149.8:7101
```

## JavaScript Usage

```js
import {
  createWallet,
  loadWallet,
  getBalance,
  sendTransaction
} from 'xyqon-client';

const wallet = createWallet('Cathy');
console.log(wallet.public_key);

const balance = await getBalance(wallet.public_key);
console.log(balance);

await sendTransaction({
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  amount: 1
});
```
