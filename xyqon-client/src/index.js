import { ed25519 } from '@noble/curves/ed25519';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

export const DEFAULT_PEERS = [
  '68.183.98.134:7101',
  '143.244.149.8:7101',
  '147.182.138.183:7101'
];
const XYQON_EPSILON = 0.00000001;
export const DEFAULT_XYQON_TRANSACTION_FEE = 0.001;

export const DEFAULT_WALLET_PATH = 'xyqon.wallet.json';

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('expected a valid hex string');
  }

  return Uint8Array.from(hex.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
}

export function normalizePeer(peer) {
  const value = `${peer}`.split('#')[0].trim();
  if (!value) {
    return null;
  }

  return value.includes(':') ? value : `${value}:7101`;
}

export function normalizePeers(peers = DEFAULT_PEERS) {
  return [...new Set(peers.map(normalizePeer).filter(Boolean))];
}

export function createWallet(name = 'XYQON User') {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    name,
    public_key: bytesToHex(publicKey),
    private_key: bytesToHex(privateKey)
  };
}

export async function saveWallet(wallet, path = DEFAULT_WALLET_PATH) {
  await writeFile(path, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600 });
}

export async function loadWallet(path = DEFAULT_WALLET_PATH) {
  const wallet = JSON.parse(await readFile(path, 'utf8'));
  if (!wallet.name || !wallet.public_key || !wallet.private_key) {
    throw new Error(`wallet file is missing required fields: ${path}`);
  }

  return wallet;
}

function rustJsonNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error('amount must be a finite number');
  }

  return Number.isInteger(numeric) ? `${numeric}.0` : `${numeric}`;
}

function jsonString(value) {
  return JSON.stringify(`${value}`);
}

function stringifyAssetOperationForSigning(assetOperation) {
  if (!assetOperation) {
    return null;
  }

  if (assetOperation.CreateCoin) {
    const coin = assetOperation.CreateCoin;
    return `{"CreateCoin":{"symbol":${jsonString(coin.symbol)},"name":${jsonString(coin.name)},"supply":${rustJsonNumber(coin.supply)}}}`;
  }

  if (assetOperation.TransferCoin) {
    const transfer = assetOperation.TransferCoin;
    return `{"TransferCoin":{"symbol":${jsonString(transfer.symbol)},"amount":${rustJsonNumber(transfer.amount)}}}`;
  }

  if (assetOperation.RegisterCollection) {
    const value = assetOperation.RegisterCollection;
    const minters = JSON.stringify(value.authorized_minters);
    const metadata = value.metadata_url ? `,"metadata_url":${jsonString(value.metadata_url)}` : '';
    return `{"RegisterCollection":{"collection":${jsonString(value.collection)},"authorized_minters":${minters}${metadata},"authority_mutable":${value.authority_mutable}}}`;
  }

  if (assetOperation.UpdateCollection) {
    const value = assetOperation.UpdateCollection;
    const minters = JSON.stringify(value.authorized_minters);
    const metadata = value.metadata_url ? `,"metadata_url":${jsonString(value.metadata_url)}` : '';
    return `{"UpdateCollection":{"collection":${jsonString(value.collection)},"authorized_minters":${minters}${metadata}}}`;
  }

  if (assetOperation.LockCollection) {
    return `{"LockCollection":{"collection":${jsonString(assetOperation.LockCollection.collection)}}}`;
  }

  if (assetOperation.MintNft) {
    const nft = assetOperation.MintNft;
    const imageUrl = nft.image_url ? `,"image_url":${jsonString(nft.image_url)}` : '';
    return `{"MintNft":{"collection":${jsonString(nft.collection)},"token_id":${jsonString(nft.token_id)},"name":${jsonString(nft.name)}${imageUrl}}}`;
  }

  if (assetOperation.TransferNft) {
    const transfer = assetOperation.TransferNft;
    return `{"TransferNft":{"collection":${jsonString(transfer.collection)},"token_id":${jsonString(transfer.token_id)}}}`;
  }

  throw new Error('unknown asset operation');
}

export function transactionPayload(sender, recipient, amount, senderPublicKey, assetOperation = null, fee = 0) {
  let base = `${sender}|${recipient}|${Number(amount).toFixed(8)}|${senderPublicKey}`;
  if (Math.abs(Number(fee)) > XYQON_EPSILON) {
    base = `${base}|fee:${Number(fee).toFixed(8)}`;
  }
  const serializedAsset = stringifyAssetOperationForSigning(assetOperation);
  return serializedAsset ? `${base}|${serializedAsset}` : base;
}

function assertWalletMatchesPrivateKey(wallet, privateKey) {
  const senderPublicKey = bytesToHex(ed25519.getPublicKey(privateKey));
  if (senderPublicKey !== wallet.public_key) {
    throw new Error('wallet public key does not match its private key');
  }

  return senderPublicKey;
}

function createSignedAssetTransaction(wallet, recipient, assetOperation) {
  const privateKey = hexToBytes(wallet.private_key);
  const senderPublicKey = assertWalletMatchesPrivateKey(wallet, privateKey);
  const payload = transactionPayload(wallet.name, recipient, 0, senderPublicKey, assetOperation);
  const signature = ed25519.sign(new TextEncoder().encode(payload), privateKey);

  return {
    sender: wallet.name,
    recipient,
    amount: 0,
    sender_public_key: senderPublicKey,
    signature: bytesToHex(signature),
    asset_operation: assetOperation
  };
}

export function normalizeCoinSymbol(symbol) {
  const value = `${symbol}`.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(value)) {
    throw new Error('coin symbol must be 2 to 12 letters or numbers');
  }

  return value;
}

export function normalizeAssetName(name) {
  const value = `${name}`.trim();
  if (!value || value.length > 64) {
    throw new Error('asset name must be 1 to 64 characters');
  }

  return value;
}

export function normalizeTokenId(tokenId) {
  const value = `${tokenId}`.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(value)) {
    throw new Error('NFT token id must be 1 to 64 letters, numbers, hyphens, or underscores');
  }

  return value;
}

export function normalizeTokenAmount(amount, label = 'amount') {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }

  if (Math.round(numeric * 100_000_000) / 100_000_000 !== numeric) {
    throw new Error(`${label} can have at most 8 decimal places`);
  }

  return numeric;
}

export function normalizePublicKeys(publicKeys) {
  const values = [...new Set(publicKeys.map((value) => `${value}`.trim().toLowerCase()))];
  if (values.length < 1 || values.length > 32 || values.some((value) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error('authorized minters must contain 1 to 32 Ed25519 public keys');
  }
  return values;
}

function normalizeMetadataUrl(metadataUrl) {
  if (!metadataUrl) return null;
  const value = `${metadataUrl}`.trim();
  if (value.length > 512 || !/^(https:\/\/|ipfs:\/\/)/i.test(value)) {
    throw new Error('collection metadata URL must start with https:// or ipfs:// and be at most 512 characters');
  }
  return value;
}

export function createSignedTransaction(wallet, recipient, amount, fee = DEFAULT_XYQON_TRANSACTION_FEE) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('amount must be a positive number');
  }
  const numericFee = Number(fee);
  if (!Number.isFinite(numericFee) || numericFee < 0) {
    throw new Error('fee must be a non-negative number');
  }

  const privateKey = hexToBytes(wallet.private_key);
  const senderPublicKey = assertWalletMatchesPrivateKey(wallet, privateKey);

  const payload = transactionPayload(wallet.name, recipient, numericAmount, senderPublicKey, null, numericFee);
  const signature = ed25519.sign(new TextEncoder().encode(payload), privateKey);

  return {
    sender: wallet.name,
    recipient,
    amount: numericAmount,
    fee: numericFee,
    sender_public_key: senderPublicKey,
    signature: bytesToHex(signature)
  };
}

export function createCoinTransaction(wallet, { symbol, name, supply }) {
  const senderPublicKey = wallet.public_key;
  const assetOperation = {
    CreateCoin: {
      symbol: normalizeCoinSymbol(symbol),
      name: normalizeAssetName(name),
      supply: normalizeTokenAmount(supply, 'coin supply')
    }
  };

  return createSignedAssetTransaction(wallet, senderPublicKey, assetOperation);
}

export function createCoinTransferTransaction(wallet, { recipient, symbol, amount }) {
  if (!recipient) {
    throw new Error('coin transfer requires a recipient public key');
  }

  const assetOperation = {
    TransferCoin: {
      symbol: normalizeCoinSymbol(symbol),
      amount: normalizeTokenAmount(amount, 'coin transfer amount')
    }
  };

  return createSignedAssetTransaction(wallet, recipient, assetOperation);
}

export function createCollectionRegistrationTransaction(wallet, { collection, authorizedMinters, metadataUrl = null, authorityMutable = true }) {
  const operation = { RegisterCollection: {
    collection: normalizeCoinSymbol(collection),
    authorized_minters: normalizePublicKeys(authorizedMinters),
    ...(normalizeMetadataUrl(metadataUrl) ? { metadata_url: normalizeMetadataUrl(metadataUrl) } : {}),
    authority_mutable: Boolean(authorityMutable)
  } };
  return createSignedAssetTransaction(wallet, wallet.public_key, operation);
}

export function createCollectionUpdateTransaction(wallet, { collection, authorizedMinters, metadataUrl = null }) {
  const operation = { UpdateCollection: {
    collection: normalizeCoinSymbol(collection),
    authorized_minters: normalizePublicKeys(authorizedMinters),
    ...(normalizeMetadataUrl(metadataUrl) ? { metadata_url: normalizeMetadataUrl(metadataUrl) } : {})
  } };
  return createSignedAssetTransaction(wallet, wallet.public_key, operation);
}

export function createCollectionLockTransaction(wallet, { collection }) {
  const operation = { LockCollection: { collection: normalizeCoinSymbol(collection) } };
  return createSignedAssetTransaction(wallet, wallet.public_key, operation);
}

export function createNftMintTransaction(wallet, { collection, tokenId, name, imageUrl = null }) {
  const senderPublicKey = wallet.public_key;
  const mint = {
    collection: normalizeCoinSymbol(collection),
    token_id: normalizeTokenId(tokenId),
    name: normalizeAssetName(name)
  };

  if (imageUrl) {
    const value = `${imageUrl}`.trim();
    if (value.length > 512 || !/^https?:\/\//i.test(value)) {
      throw new Error('NFT image URL must start with http:// or https:// and be at most 512 characters');
    }
    mint.image_url = value;
  }

  return createSignedAssetTransaction(wallet, senderPublicKey, { MintNft: mint });
}

export function createNftTransferTransaction(wallet, { recipient, collection, tokenId }) {
  if (!recipient) {
    throw new Error('NFT transfer requires a recipient public key');
  }

  const assetOperation = {
    TransferNft: {
      collection: normalizeCoinSymbol(collection),
      token_id: normalizeTokenId(tokenId)
    }
  };

  return createSignedAssetTransaction(wallet, recipient, assetOperation);
}

export function transactionId(transaction) {
  return createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
}

export function requestMessage(peer, message, responseKey, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const normalizedPeer = normalizePeer(peer);
    const [host, portText] = normalizedPeer.split(':');
    const socket = net.createConnection({ host, port: Number(portText) });
    const startedAt = Date.now();
    let data = '';
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ peer: normalizedPeer, latencyMs: Date.now() - startedAt, ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) {
        return;
      }

      try {
        const parsed = JSON.parse(data.trim());
        finish({ ok: true, payload: parsed[responseKey] });
      } catch (error) {
        finish({ ok: false, error: error.message });
      }
    });
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.on('error', (error) => finish({ ok: false, error: error.message }));
  });
}

export function sendNetworkMessage(peer, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const normalizedPeer = normalizePeer(peer);
    const [host, portText] = normalizedPeer.split(':');
    const socket = net.createConnection({ host, port: Number(portText) });
    const startedAt = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ peer: normalizedPeer, latencyMs: Date.now() - startedAt, ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`, () => finish({ ok: true }));
    });
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.on('error', (error) => finish({ ok: false, error: error.message }));
  });
}

export function sendTransactionMessage(peer, transaction, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const normalizedPeer = normalizePeer(peer);
    const [host, portText] = normalizedPeer.split(':');
    const socket = net.createConnection({ host, port: Number(portText) });
    const startedAt = Date.now();
    const id = transactionId(transaction);
    let data = '';
    let wrote = false;
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ peer: normalizedPeer, latencyMs: Date.now() - startedAt, ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ NewTransaction: transaction })}\n`, () => {
        wrote = true;
      });
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) {
        return;
      }

      try {
        const parsed = JSON.parse(data.trim());
        const status = parsed.TransactionResponse;
        if (!status || status.id !== id) {
          finish({ ok: false, submitted: wrote, error: 'peer returned an unexpected transaction response' });
          return;
        }

        finish({
          ok: status.status === 'pending' || status.status === 'confirmed',
          submitted: status.status === 'pending' || status.status === 'confirmed',
          verified: true,
          status: status.status,
          error: status.error ?? undefined
        });
      } catch (error) {
        finish({ ok: false, submitted: wrote, error: error.message });
      }
    });
    socket.on('timeout', () => finish({ ok: false, submitted: wrote, verified: false, error: 'timeout waiting for transaction response' }));
    socket.on('error', (error) => finish({ ok: false, submitted: wrote, error: error.message }));
  });
}

export async function requestChain(peer) {
  const result = await requestMessage(peer, 'RequestChain', 'ChainResponse');
  return { ...result, chain: result.payload };
}

export async function requestPeers(peer) {
  const result = await requestMessage(peer, 'RequestPeers', 'PeerResponse');
  return {
    ...result,
    peers: Array.isArray(result.payload) ? normalizePeers(result.payload) : []
  };
}

export async function requestTransactionStatus(peer, id) {
  const result = await requestMessage(peer, { RequestTransaction: id }, 'TransactionResponse');
  return {
    ...result,
    transaction: result.payload,
    status: result.payload?.status,
    verified: result.ok && (result.payload?.status === 'pending' || result.payload?.status === 'confirmed')
  };
}

export async function discoverPeers(seedPeers = DEFAULT_PEERS) {
  const discovered = new Set(normalizePeers(seedPeers));
  let frontier = [...discovered];

  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const responses = await Promise.all(frontier.map((peer) => requestPeers(peer)));
    const next = [];

    for (const response of responses) {
      if (!response.ok) {
        continue;
      }

      for (const peer of response.peers) {
        if (!discovered.has(peer)) {
          discovered.add(peer);
          next.push(peer);
        }
      }
    }

    frontier = next;
  }

  return [...discovered].sort();
}

export async function getBestChain(seedPeers = DEFAULT_PEERS) {
  const peers = await discoverPeers(seedPeers);
  const responses = await Promise.all(peers.map((peer) => requestChain(peer)));
  const online = responses.filter((response) => response.ok && response.chain);

  if (online.length === 0) {
    throw new Error('no reachable XYQON nodes returned a chain');
  }

  online.sort((left, right) => chainScore(right.chain) - chainScore(left.chain));
  return {
    sourcePeer: online[0].peer,
    peers,
    nodes: responses,
    chain: online[0].chain
  };
}

export function chainScore(chain) {
  return chain.chain.slice(1).reduce((score, block) => score + 2 ** Math.min(block.difficulty, 52), 0);
}

export function calculateBalances(chain) {
  const balances = new Map();
  const credit = (address, amount) => balances.set(address, (balances.get(address) ?? 0) + amount);
  const debit = (address, amount) => balances.set(address, (balances.get(address) ?? 0) - amount);

  for (const block of chain.chain.slice(1)) {
    const [coinbase, ...transactions] = block.transactions;
    if (coinbase?.recipient) {
      credit(coinbase.recipient, coinbase.amount);
    }

    for (const transaction of transactions) {
      if (transaction.asset_operation) {
        continue;
      }
      debit(transaction.sender_public_key, transaction.amount + (transaction.fee ?? 0));
      credit(transaction.recipient, transaction.amount);
    }
  }

  return balances;
}

export function calculateAssets(chain) {
  const coins = new Map();
  const nfts = new Map();

  const ensureCoin = (symbol, name = symbol, supply = 0) => {
    if (!coins.has(symbol)) {
      coins.set(symbol, { symbol, name, supply, holders: new Map() });
    }
    return coins.get(symbol);
  };

  const addBalance = (symbol, address, amount) => {
    const coin = ensureCoin(symbol);
    coin.holders.set(address, (coin.holders.get(address) ?? 0) + amount);
  };

  for (const block of chain.chain.slice(1)) {
    for (const transaction of block.transactions.slice(1)) {
      const operation = transaction.asset_operation;
      if (!operation) {
        continue;
      }

      if (operation.CreateCoin) {
        const coin = operation.CreateCoin;
        const symbol = normalizeCoinSymbol(coin.symbol);
        const record = ensureCoin(symbol, coin.name, coin.supply);
        record.creator = transaction.sender_public_key;
        addBalance(symbol, transaction.sender_public_key, coin.supply);
      } else if (operation.TransferCoin) {
        const transfer = operation.TransferCoin;
        const symbol = normalizeCoinSymbol(transfer.symbol);
        addBalance(symbol, transaction.sender_public_key, -transfer.amount);
        addBalance(symbol, transaction.recipient, transfer.amount);
      } else if (operation.MintNft) {
        const nft = operation.MintNft;
        const collection = normalizeCoinSymbol(nft.collection);
        const tokenId = normalizeTokenId(nft.token_id);
        nfts.set(`${collection}:${tokenId}`, {
          collection,
          tokenId,
          name: nft.name,
          imageUrl: nft.image_url ?? null,
          creator: transaction.sender_public_key,
          owner: transaction.sender_public_key
        });
      } else if (operation.TransferNft) {
        const transfer = operation.TransferNft;
        const key = `${normalizeCoinSymbol(transfer.collection)}:${normalizeTokenId(transfer.token_id)}`;
        const nft = nfts.get(key);
        if (nft) {
          nft.owner = transaction.recipient;
        }
      }
    }
  }

  return {
    coins: [...coins.values()].map((coin) => ({
      ...coin,
      creator: coin.creator ?? null,
      holders: [...coin.holders.entries()]
        .map(([address, balance]) => ({ address, balance }))
        .filter((holder) => Math.abs(holder.balance) > 0.00000001)
        .sort((left, right) => right.balance - left.balance)
    })),
    nfts: [...nfts.values()].sort((left, right) =>
      `${left.collection}:${left.tokenId}`.localeCompare(`${right.collection}:${right.tokenId}`)
    )
  };
}

export function listCoinsCreatedBy(chain, addressOrWallet) {
  const address = typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key;
  return calculateAssets(chain).coins.filter((coin) => coin.creator === address);
}

export function listNftsCreatedBy(chain, addressOrWallet) {
  const address = typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key;
  return calculateAssets(chain).nfts.filter((nft) => nft.creator === address);
}

export function listNftsOwnedBy(chain, addressOrWallet) {
  const address = typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key;
  return calculateAssets(chain).nfts.filter((nft) => nft.owner === address);
}

export function listCoinHoldings(chain, addressOrWallet) {
  const address = typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key;
  return calculateAssets(chain).coins
    .map((coin) => ({
      symbol: coin.symbol,
      name: coin.name,
      supply: coin.supply,
      creator: coin.creator,
      balance: coin.holders.find((holder) => holder.address === address)?.balance ?? 0
    }))
    .filter((coin) => Math.abs(coin.balance) > 0.00000001);
}

export async function getBalance(addressOrWallet, seedPeers = DEFAULT_PEERS) {
  const address = typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key;
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  const balances = calculateBalances(chain);

  return {
    address,
    balance: balances.get(address) ?? 0,
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    circulatingSupply: chain.circulating_supply,
    sourcePeer,
    peers
  };
}

export async function assertSpendableXyqonBalance(wallet, amount, seedPeers = DEFAULT_PEERS, fee = 0) {
  const numericAmount = Number(amount);
  const numericFee = Number(fee);
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  const balances = calculateBalances(chain);
  const balance = balances.get(wallet.public_key) ?? 0;
  const totalDebit = numericAmount + numericFee;

  if (balance + XYQON_EPSILON < totalDebit) {
    throw new Error(
      `insufficient confirmed XYQON balance; balance is ${balance}, attempted to spend ${numericAmount} plus fee ${numericFee}`
    );
  }

  return {
    balance,
    fee: numericFee,
    totalDebit,
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function assertSpendableCoinBalance(wallet, symbol, amount, seedPeers = DEFAULT_PEERS) {
  const normalizedSymbol = normalizeCoinSymbol(symbol);
  const numericAmount = Number(amount);
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  const holding = listCoinHoldings(chain, wallet).find((coin) => coin.symbol === normalizedSymbol);
  const balance = holding?.balance ?? 0;

  if (balance + XYQON_EPSILON < numericAmount) {
    throw new Error(
      `insufficient confirmed ${normalizedSymbol} balance; balance is ${balance}, attempted to spend ${numericAmount}`
    );
  }

  return {
    symbol: normalizedSymbol,
    balance,
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function getCreatedCoins(addressOrWallet, seedPeers = DEFAULT_PEERS) {
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  return {
    address: typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key,
    coins: listCoinsCreatedBy(chain, addressOrWallet),
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function getCreatedNfts(addressOrWallet, seedPeers = DEFAULT_PEERS) {
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  return {
    address: typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key,
    nfts: listNftsCreatedBy(chain, addressOrWallet),
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function getOwnedNfts(addressOrWallet, seedPeers = DEFAULT_PEERS) {
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  return {
    address: typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key,
    nfts: listNftsOwnedBy(chain, addressOrWallet),
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function getCoinHoldings(addressOrWallet, seedPeers = DEFAULT_PEERS) {
  const { chain, sourcePeer, peers } = await getBestChain(seedPeers);
  return {
    address: typeof addressOrWallet === 'string' ? addressOrWallet : addressOrWallet.public_key,
    coins: listCoinHoldings(chain, addressOrWallet),
    blockHeight: chain.chain.at(-1)?.index ?? 0,
    sourcePeer,
    peers
  };
}

export async function broadcastTransaction(transaction, seedPeers = DEFAULT_PEERS) {
  const peers = await discoverPeers(seedPeers);
  const id = transactionId(transaction);
  const results = await Promise.all(peers.map((peer) => sendTransactionMessage(peer, transaction)));
  const verifiedResults = results.filter((result) => result.verified);
  const rejectedResults = results.filter((result) => result.status === 'rejected');

  return {
    transactionId: id,
    peers,
    results,
    acceptedBy: verifiedResults.length,
    verifiedBy: verifiedResults.length,
    rejectedBy: rejectedResults.length,
    unverifiedBy: results.filter((result) => result.submitted && !result.verified).length
  };
}

function assertBroadcastVerified(broadcast) {
  if (broadcast.verifiedBy > 0) {
    return broadcast;
  }

  const rejection = broadcast.results.find((result) => result.status === 'rejected' && result.error);
  const failure = rejection ?? broadcast.results.find((result) => result.error);
  const detail = failure ? ` ${failure.peer}: ${failure.error}` : '';
  throw new Error(`transaction was not accepted by any reachable XYQON node.${detail}`);
}

export async function sendTransaction({ wallet, recipient, amount, fee = DEFAULT_XYQON_TRANSACTION_FEE, peers = DEFAULT_PEERS }) {
  const transaction = createSignedTransaction(wallet, recipient, amount, fee);
  const preflight = await assertSpendableXyqonBalance(wallet, transaction.amount, peers, transaction.fee);
  const broadcast = assertBroadcastVerified(await broadcastTransaction(transaction, peers));
  return {
    transaction,
    preflight,
    ...broadcast
  };
}

export async function createCoin({ wallet, symbol, name, supply, peers = DEFAULT_PEERS }) {
  const transaction = createCoinTransaction(wallet, { symbol, name, supply });
  const broadcast = assertBroadcastVerified(await broadcastTransaction(transaction, peers));
  return {
    transaction,
    ...broadcast
  };
}

export async function sendCoin({ wallet, recipient, symbol, amount, peers = DEFAULT_PEERS }) {
  const transaction = createCoinTransferTransaction(wallet, { recipient, symbol, amount });
  const preflight = await assertSpendableCoinBalance(
    wallet,
    transaction.asset_operation.TransferCoin.symbol,
    transaction.asset_operation.TransferCoin.amount,
    peers
  );
  const broadcast = assertBroadcastVerified(await broadcastTransaction(transaction, peers));
  return {
    transaction,
    preflight,
    ...broadcast
  };
}

export async function registerCollection({ wallet, collection, authorizedMinters = [wallet.public_key], metadataUrl = null, authorityMutable = true, peers = DEFAULT_PEERS }) {
  const transaction = createCollectionRegistrationTransaction(wallet, { collection, authorizedMinters, metadataUrl, authorityMutable });
  return { transaction, ...assertBroadcastVerified(await broadcastTransaction(transaction, peers)) };
}

export async function updateCollection({ wallet, collection, authorizedMinters, metadataUrl = null, peers = DEFAULT_PEERS }) {
  const transaction = createCollectionUpdateTransaction(wallet, { collection, authorizedMinters, metadataUrl });
  return { transaction, ...assertBroadcastVerified(await broadcastTransaction(transaction, peers)) };
}

export async function lockCollection({ wallet, collection, peers = DEFAULT_PEERS }) {
  const transaction = createCollectionLockTransaction(wallet, { collection });
  return { transaction, ...assertBroadcastVerified(await broadcastTransaction(transaction, peers)) };
}

export async function mintNft({ wallet, collection, tokenId, name, imageUrl = null, peers = DEFAULT_PEERS }) {
  const transaction = createNftMintTransaction(wallet, { collection, tokenId, name, imageUrl });
  const broadcast = assertBroadcastVerified(await broadcastTransaction(transaction, peers));
  return {
    transaction,
    ...broadcast
  };
}

export async function transferNft({ wallet, recipient, collection, tokenId, peers = DEFAULT_PEERS }) {
  const transaction = createNftTransferTransaction(wallet, { recipient, collection, tokenId });
  const broadcast = assertBroadcastVerified(await broadcastTransaction(transaction, peers));
  return {
    transaction,
    ...broadcast
  };
}
