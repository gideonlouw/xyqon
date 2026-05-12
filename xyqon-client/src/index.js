import { ed25519 } from '@noble/curves/ed25519';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

export const DEFAULT_PEERS = [
  '68.183.98.134:7101',
  '143.244.149.8:7101',
  '147.182.138.183:7101'
];

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

export function transactionPayload(sender, recipient, amount, senderPublicKey) {
  return `${sender}|${recipient}|${Number(amount).toFixed(8)}|${senderPublicKey}`;
}

export function createSignedTransaction(wallet, recipient, amount) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const privateKey = hexToBytes(wallet.private_key);
  const senderPublicKey = bytesToHex(ed25519.getPublicKey(privateKey));
  if (senderPublicKey !== wallet.public_key) {
    throw new Error('wallet public key does not match its private key');
  }

  const payload = transactionPayload(wallet.name, recipient, numericAmount, senderPublicKey);
  const signature = ed25519.sign(new TextEncoder().encode(payload), privateKey);

  return {
    sender: wallet.name,
    recipient,
    amount: numericAmount,
    sender_public_key: senderPublicKey,
    signature: bytesToHex(signature)
  };
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
      debit(transaction.sender_public_key, transaction.amount);
      credit(transaction.recipient, transaction.amount);
    }
  }

  return balances;
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

export async function broadcastTransaction(transaction, seedPeers = DEFAULT_PEERS) {
  const peers = await discoverPeers(seedPeers);
  const message = { NewTransaction: transaction };
  const results = await Promise.all(peers.map((peer) => sendNetworkMessage(peer, message)));

  return {
    transactionId: transactionId(transaction),
    peers,
    results,
    acceptedBy: results.filter((result) => result.ok).length
  };
}

export async function sendTransaction({ wallet, recipient, amount, peers = DEFAULT_PEERS }) {
  const transaction = createSignedTransaction(wallet, recipient, amount);
  return {
    transaction,
    ...(await broadcastTransaction(transaction, peers))
  };
}
