import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const port = Number(process.env.XYQON_DASHBOARD_API_PORT ?? 4300);
const defaultPeers = ['68.183.98.134:7101', '143.244.149.8:7101', '147.182.138.183:7101'];

async function readConfiguredPeers() {
  const filePath = process.env.XYQON_PEERS_FILE ?? join(rootDir, 'peers.txt');
  if (!existsSync(filePath)) {
    return defaultPeers;
  }

  const text = await readFile(filePath, 'utf8');
  const peers = text
    .split(/\r?\n/)
    .map(normalizePeer)
    .filter(Boolean);
  return [...new Set(peers.length ? peers : defaultPeers)];
}

async function saveDiscoveredPeers(peers) {
  const filePath = process.env.XYQON_PEERS_FILE ?? join(rootDir, 'peers.txt');
  if (process.env.XYQON_DASHBOARD_SAVE_PEERS === 'false') {
    return;
  }

  const contents = `${[...new Set(peers)].sort().join('\n')}\n`;
  await writeFile(filePath, contents, 'utf8');
}

function normalizePeer(peer) {
  const value = peer.split('#')[0].trim();
  if (!value) {
    return null;
  }
  return value.includes(':') ? value : `${value}:7101`;
}

function requestMessage(peer, messageName, responseKey, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const [host, portText] = peer.split(':');
    const socket = net.createConnection({ host, port: Number(portText) });
    let data = '';
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(`"${messageName}"\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) {
        return;
      }

      try {
        const message = JSON.parse(data.trim());
        const payload = message[responseKey];
        if (!payload) {
          finish({ peer, online: false, latencyMs: Date.now() - startedAt, error: `No ${responseKey} response` });
          return;
        }
        finish({ peer, online: true, latencyMs: Date.now() - startedAt, payload, error: null });
      } catch (error) {
        finish({ peer, online: false, latencyMs: Date.now() - startedAt, error: error.message });
      }
    });
    socket.on('timeout', () => finish({ peer, online: false, latencyMs: null, error: 'Timeout' }));
    socket.on('error', (error) => finish({ peer, online: false, latencyMs: null, error: error.message }));
  });
}

async function requestChain(peer, timeoutMs = 3500) {
  const result = await requestMessage(peer, 'RequestChain', 'ChainResponse', timeoutMs);
  return { ...result, chain: result.payload };
}

async function requestPeers(peer, timeoutMs = 2500) {
  const result = await requestMessage(peer, 'RequestPeers', 'PeerResponse', timeoutMs);
  return {
    ...result,
    peers: Array.isArray(result.payload) ? result.payload.map(normalizePeer).filter(Boolean) : []
  };
}

async function discoverPeers(seedPeers) {
  const discovered = new Set(seedPeers);
  let frontier = seedPeers;

  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const responses = await Promise.all(frontier.map((peer) => requestPeers(peer)));
    const next = [];
    for (const response of responses) {
      if (!response.online) {
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

  const peers = [...discovered].sort();
  await saveDiscoveredPeers(peers);
  return peers;
}

function chainScore(chain) {
  return chain.chain
    .slice(1)
    .reduce((score, block) => score + 2 ** Math.min(block.difficulty, 52), 0);
}

function buildBalances(chain) {
  const balances = new Map();

  const ensure = (address) => {
    if (!balances.has(address)) {
      balances.set(address, { address, balance: 0, mined: 0, received: 0, sent: 0, transactions: 0 });
    }
    return balances.get(address);
  };

  for (const block of chain.chain.slice(1)) {
    const [coinbase, ...transactions] = block.transactions;
    if (coinbase?.recipient) {
      const recipient = ensure(coinbase.recipient);
      recipient.balance += coinbase.amount;
      recipient.mined += coinbase.amount;
      recipient.transactions += 1;
    }

    for (const tx of transactions) {
      if (tx.asset_operation) {
        continue;
      }
      const senderAddress = tx.sender_public_key || tx.sender;
      const sender = ensure(senderAddress);
      const recipient = ensure(tx.recipient);
      sender.balance -= tx.amount;
      sender.sent += tx.amount;
      sender.transactions += 1;
      recipient.balance += tx.amount;
      recipient.received += tx.amount;
      recipient.transactions += 1;
    }
  }

  return [...balances.values()]
    .filter((entry) => Math.abs(entry.balance) > 0.00000001 || entry.transactions > 0)
    .sort((a, b) => b.balance - a.balance);
}

function normalizeSymbol(symbol) {
  return `${symbol}`.trim().toUpperCase();
}

function normalizeTokenId(tokenId) {
  return `${tokenId}`.trim().toLowerCase();
}

function buildAssets(chain) {
  const coins = new Map();
  const nfts = new Map();

  const ensureCoin = (symbol, name = symbol, supply = 0) => {
    if (!coins.has(symbol)) {
      coins.set(symbol, {
        symbol,
        name,
        supply,
        transactions: 0,
        holders: new Map()
      });
    }
    return coins.get(symbol);
  };

  const addCoinBalance = (symbol, address, amount) => {
    const coin = ensureCoin(symbol);
    coin.holders.set(address, (coin.holders.get(address) ?? 0) + amount);
  };

  for (const block of chain.chain.slice(1)) {
    for (const tx of block.transactions.slice(1)) {
      const operation = tx.asset_operation;
      if (!operation) {
        continue;
      }

      if (operation.CreateCoin) {
        const coin = operation.CreateCoin;
        const symbol = normalizeSymbol(coin.symbol);
        const record = ensureCoin(symbol, coin.name, coin.supply);
        record.transactions += 1;
        addCoinBalance(symbol, tx.sender_public_key, coin.supply);
      } else if (operation.TransferCoin) {
        const transfer = operation.TransferCoin;
        const symbol = normalizeSymbol(transfer.symbol);
        const record = ensureCoin(symbol);
        record.transactions += 1;
        addCoinBalance(symbol, tx.sender_public_key, -transfer.amount);
        addCoinBalance(symbol, tx.recipient, transfer.amount);
      } else if (operation.MintNft) {
        const nft = operation.MintNft;
        const collection = normalizeSymbol(nft.collection);
        const tokenId = normalizeTokenId(nft.token_id);
        nfts.set(`${collection}:${tokenId}`, {
          collection,
          tokenId,
          name: nft.name,
          imageUrl: nft.image_url ?? null,
          owner: tx.sender_public_key,
          mintedInBlock: block.index,
          lastTransferBlock: null
        });
      } else if (operation.TransferNft) {
        const transfer = operation.TransferNft;
        const collection = normalizeSymbol(transfer.collection);
        const tokenId = normalizeTokenId(transfer.token_id);
        const record = nfts.get(`${collection}:${tokenId}`);
        if (record) {
          record.owner = tx.recipient;
          record.lastTransferBlock = block.index;
        }
      }
    }
  }

  return {
    coins: [...coins.values()]
      .map((coin) => ({
        symbol: coin.symbol,
        name: coin.name,
        supply: coin.supply,
        transactions: coin.transactions,
        holders: [...coin.holders.entries()]
          .map(([address, balance]) => ({ address, balance }))
          .filter((holder) => Math.abs(holder.balance) > 0.00000001)
          .sort((a, b) => b.balance - a.balance)
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    nfts: [...nfts.values()].sort((a, b) =>
      `${a.collection}:${a.tokenId}`.localeCompare(`${b.collection}:${b.tokenId}`)
    )
  };
}

function transactionId(transaction) {
  return createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
}

function flattenTransactions(chain) {
  return chain.chain.flatMap((block) =>
    block.transactions.map((transaction, index) => ({
      id: transactionId(transaction),
      blockIndex: block.index,
      transactionIndex: index,
      timestamp: block.timestamp,
      isCoinbase: index === 0,
      ...transaction
    }))
  );
}

async function getNetworkSnapshot() {
  const seedPeers = await readConfiguredPeers();
  const knownPeers = await discoverPeers(seedPeers);
  const results = await Promise.all(knownPeers.map((peer) => requestChain(peer)));
  const nodes = results.map((result) => ({
    address: result.peer,
    online: result.online,
    latencyMs: result.latencyMs,
    blockHeight: result.chain ? result.chain.chain.length - 1 : null,
    chainScore: result.chain ? chainScore(result.chain) : 0,
    circulatingSupply: result.chain?.circulating_supply ?? null,
    error: result.error
  }));

  const best = results
    .filter((result) => result.chain)
    .sort((a, b) => chainScore(b.chain) - chainScore(a.chain))[0];

  const chain = best?.chain ?? { chain: [], circulating_supply: 0 };
  return { knownPeers, seedPeers, results, nodes, best, chain };
}

async function getDashboard() {
  const { knownPeers, seedPeers, nodes, best, chain } = await getNetworkSnapshot();
  const latestBlock = chain.chain.at(-1) ?? null;
  const balances = buildBalances(chain);
  const assets = buildAssets(chain);
  const transactions = flattenTransactions(chain);

  return {
    generatedAt: new Date().toISOString(),
    sourceNode: best?.peer ?? null,
    seedPeers,
    knownPeers,
    nodes,
    chain: {
      blockHeight: latestBlock ? latestBlock.index : 0,
      blockCount: chain.chain.length,
      circulatingSupply: chain.circulating_supply,
      lastBlockHash: latestBlock?.hash ?? null,
      lastBlockTime: latestBlock ? new Date(latestBlock.timestamp * 1000).toISOString() : null
    },
    richList: balances.slice(0, 25),
    publicAddresses: balances,
    coins: assets.coins,
    nfts: assets.nfts,
    recentBlocks: chain.chain.slice(-8).reverse(),
    recentTransactions: transactions.slice(-12).reverse()
  };
}

async function getAddress(address) {
  const { chain, best } = await getNetworkSnapshot();
  const balances = buildBalances(chain);
  const transactions = flattenTransactions(chain).filter(
    (transaction) => transaction.recipient === address || transaction.sender_public_key === address
  );
  return {
    sourceNode: best?.peer ?? null,
    address,
    balance: balances.find((entry) => entry.address === address) ?? {
      address,
      balance: 0,
      mined: 0,
      received: 0,
      sent: 0,
      transactions: 0
    },
    transactions: transactions.reverse()
  };
}

async function getBlock(id) {
  const { chain, best } = await getNetworkSnapshot();
  const block = chain.chain.find((candidate) => `${candidate.index}` === id || candidate.hash === id);
  return { sourceNode: best?.peer ?? null, block: block ?? null };
}

async function getTransaction(id) {
  const { chain, best } = await getNetworkSnapshot();
  const transaction = flattenTransactions(chain).find((candidate) => candidate.id === id);
  return { sourceNode: best?.peer ?? null, transaction: transaction ?? null };
}

async function getAssets() {
  const { chain, best } = await getNetworkSnapshot();
  return { sourceNode: best?.peer ?? null, ...buildAssets(chain) };
}

async function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  response.end(JSON.stringify(body));
}

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/dashboard') {
    try {
      await sendJson(response, 200, await getDashboard());
    } catch (error) {
      await sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/address/')) {
    await sendJson(response, 200, await getAddress(decodeURIComponent(url.pathname.slice('/api/address/'.length))));
    return;
  }

  if (url.pathname.startsWith('/api/block/')) {
    await sendJson(response, 200, await getBlock(decodeURIComponent(url.pathname.slice('/api/block/'.length))));
    return;
  }

  if (url.pathname.startsWith('/api/transaction/')) {
    await sendJson(
      response,
      200,
      await getTransaction(decodeURIComponent(url.pathname.slice('/api/transaction/'.length)))
    );
    return;
  }

  if (url.pathname === '/api/assets') {
    await sendJson(response, 200, await getAssets());
    return;
  }

  if (url.pathname === '/api/health') {
    await sendJson(response, 200, { ok: true });
    return;
  }

  await sendJson(response, 404, { error: 'Not found' });
}

if (process.argv.includes('--once')) {
  console.log(JSON.stringify(await getDashboard(), null, 2));
} else {
  http.createServer(handleRequest).listen(port, '127.0.0.1', () => {
    console.log(`XYQON dashboard API listening on http://127.0.0.1:${port}`);
  });
}
