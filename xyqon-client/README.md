# XYQON Client

Friendly wallet CLI and JavaScript client for the live XYQON network.

It can:

- Generate a new XYQON wallet
- Show your public key
- Check your balance from live public nodes
- Send a signed transaction to the network
- Create and send coins on the XYQON network
- Mint and transfer NFTs
- Show currently reachable nodes

You do not need to mine and you do not need to run a full node.

## Install

```bash
npm install -g xyqon
```

Update an existing global install:

```bash
npm update -g xyqon
```

Or install this exact release:

```bash
npm install -g xyqon@0.5.0
```

Or run without installing:

```bash
npx xyqon help
```

Run this exact release without installing:

```bash
npx xyqon@0.5.0 help
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
The client checks the best reachable public chain before broadcasting, refuses sends that exceed the wallet's confirmed XYQON balance, and now requires at least one node to verify the transaction as pending or confirmed before returning success.
If every reachable node rejects the transaction or cannot return a transaction status, the send fails with the node's rejection reason when available.

## Create And Send Coins

```bash
xyqon coin create \
  --symbol GAME \
  --name "Game Coin" \
  --supply 1000000

xyqon coin send \
  --symbol GAME \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 25
```

Coin creation and coin sends are signed 0 XYQON transactions. A miner must include them before the new coin or transfer appears on-chain.
Before broadcasting a coin transfer, the client checks the best reachable public chain and refuses sends that exceed the wallet's confirmed coin balance.

## Mint And Send NFTs

Register a protected collection before minting production NFTs. The registering wallet becomes
the collection creator. Repeat `--minter` to authorize multiple wallets; omit it to authorize the
creator wallet. `--immutable` prevents all later registry updates.

```bash
xyqon collection register \
  --collection ECHOINSTR \
  --minter GAME_MINTER_PUBLIC_KEY \
  --metadata-url ipfs://COLLECTION_METADATA

xyqon collection update \
  --collection ECHOINSTR \
  --minter REPLACEMENT_MINTER_PUBLIC_KEY

xyqon collection lock --collection ECHOINSTR
```

Locking is permanent and freezes the metadata and authorized-minter list. It does not stop the
already-authorized wallets from minting.

```bash
xyqon nft mint \
  --collection ITEMS \
  --token-id sword-001 \
  --name "Iron Sword" \
  --image-url https://example.com/iron-sword.png

xyqon nft send \
  --collection ITEMS \
  --token-id sword-001 \
  --to RECIPIENT_PUBLIC_KEY
```

## Show Nodes

```bash
xyqon nodes
```

## Show Version

```bash
xyqon version
xyqon -v
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
  sendTransaction,
  createCoin,
  sendCoin,
  registerCollection,
  updateCollection,
  lockCollection,
  mintNft,
  transferNft,
  getCreatedCoins,
  getCreatedNfts,
  getOwnedNfts,
  getCoinHoldings
} from 'xyqon';

const wallet = createWallet('Cathy');
console.log(wallet.public_key);

const balance = await getBalance(wallet.public_key);
console.log(balance);

await sendTransaction({
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  amount: 1
});

await createCoin({
  wallet,
  symbol: 'GAME',
  name: 'Game Coin',
  supply: 1000000
});

await sendCoin({
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  symbol: 'GAME',
  amount: 25
});

await registerCollection({
  wallet,
  collection: 'ECHOINSTR',
  authorizedMinters: [wallet.public_key],
  metadataUrl: 'ipfs://COLLECTION_METADATA',
  authorityMutable: true
});

await mintNft({
  wallet,
  collection: 'ITEMS',
  tokenId: 'sword-001',
  name: 'Iron Sword',
  imageUrl: 'https://example.com/iron-sword.png'
});

await transferNft({
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  collection: 'ITEMS',
  tokenId: 'sword-001'
});

const createdCoins = await getCreatedCoins(wallet);
const createdNfts = await getCreatedNfts(wallet);
const ownedNfts = await getOwnedNfts(wallet);
const coinHoldings = await getCoinHoldings(wallet);
```
