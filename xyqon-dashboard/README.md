# XYQON Web

Angular website for the live XYQON network, intended for Firebase Hosting at:

```text
https://xyqon.web.app
```

It includes a public landing page, public node dashboard, public block explorer, and a Google-authenticated community page that writes signed-in members to Firestore.

It shows:

- Public landing page for Xyqon
- Live node reachability
- Current block height and circulating supply
- Public addresses seen on-chain
- Rich list sorted by balance
- Coins and holders seen on-chain
- NFTs and current owners seen on-chain
- Recent blocks
- Recent transactions
- Explorer search for addresses, blocks, and transactions
- Google sign-in for Xyqon community membership

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

## Firebase Config

The real Firebase web settings are intentionally not committed.

For local production/deploy builds, create:

```text
src/environments/firebase-config.local.ts
```

Use `src/environments/firebase-config.example.ts` as the template. The local file is ignored by Git.

Development builds use placeholder config. Production builds replace it with `firebase-config.local.ts`.

## Firebase Deploy

Install the Firebase deployment tools:

```bash
npm install --save-dev firebase-tools
```

Sign in, select your Firebase project, and deploy:

```bash
npx firebase login
npx firebase use YOUR_FIREBASE_PROJECT_ID
npx firebase deploy --only hosting
```

If you want a specific Firebase Hosting site id, create it in your own project first:

```bash
npx firebase hosting:sites:create YOUR_SITE_ID --project YOUR_FIREBASE_PROJECT_ID
```

If the preferred site id is unavailable, deploy to the default project URL or add a custom domain in Firebase Hosting.

## Developers

Install the XYQON client package:

```bash
npm install xyqon
```

Create an app wallet, read balances, and send transactions:

```js
import { createWallet, getBalance, sendTransaction } from 'xyqon';

const wallet = createWallet('Builder');
const balance = await getBalance(wallet.public_key);

await sendTransaction({
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  amount: 1
});
```

Create and transfer project coins:

```js
import { createCoin, sendCoin } from 'xyqon';

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
```

Mint and transfer NFTs:

```js
import { mintNft, transferNft } from 'xyqon';

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
