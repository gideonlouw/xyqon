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
const genesisBlockHash = '000050e03846e2151e572a3d14ded847ca0e285cab344557fa4fde4e164914ff';
const genesisTimestamp = 1_700_000_000;
const emptyRewardBlockRejectionStartTimestamp = 1_780_732_800;
const transactionFeeStartTimestamp = 1_780_747_200;
const publicMinerRewardStartTimestamp = 1_780_747_200;
const defaultTransactionFee = 0.001;
const initialMiningReward = 10;
const halvingInterval = 100_000;
const maxCoinSupply = 67_000_000;
const amountEpsilon = 0.000_000_01;
const trustedMinerRewardWallets = new Map([
  ['143.244.149.8:7101', '5a158b3821cc53e8838f02a4b7f2e7ec7849588907e18682fa982c3328eeec80'],
  ['68.183.98.134:7101', '738dc51f2251240ad28fcbadb196b4bbe2868b90e1c63490af61104e5d3f4576'],
  ['147.182.138.183:7101', '3346ff38cdb9a27bb403943b120da896a9799b1dc37438ac6a69be76394440fd']
]);

async function readConfiguredPeers() {
  const filePath = process.env.XYQON_PEERS_FILE ?? join(rootDir, 'peers.txt');
  if (!existsSync(filePath)) {
    return defaultPeers;
  }

  let text = '';
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return defaultPeers;
  }
  const peers = text
    .split(/\r?\n/)
    .map(normalizePeer)
    .filter(Boolean);
  return [...new Set(peers.length ? peers : defaultPeers)];
}

async function saveDiscoveredPeers(peers) {
  const filePath = process.env.XYQON_PEERS_FILE ?? join(rootDir, 'peers.txt');
  if (process.env.XYQON_DASHBOARD_SAVE_PEERS === 'false' || process.env.K_SERVICE) {
    return;
  }

  const contents = `${[...new Set(peers)].sort().join('\n')}\n`;
  await writeFile(filePath, contents, 'utf8');
}

function normalizePeer(peer) {
  const value = `${peer}`.split('#')[0].trim();
  if (!value) {
    return null;
  }
  const normalized = value.includes(':') ? value : `${value}:7101`;
  return isValidPeerAddress(normalized) ? normalized : null;
}

function isValidPeerAddress(peer) {
  const match = peer.match(/^([a-z0-9.-]+):([0-9]{1,5})$/i);
  if (!match) {
    return false;
  }

  const [, host, portText] = match;
  const portNumber = Number(portText);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return false;
  }

  return (
    host === 'localhost' ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)
  );
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

function chainHasOnlyKnownMinerPeers(chain, knownMinerPeers) {
  return chain.chain.every((block) => !block.miner_peer || knownMinerPeers.has(normalizePeer(block.miner_peer)));
}

function chainHasExpectedMinerRewards(chain) {
  return chain.chain.every((block) => {
    if (!block.miner_peer || block.timestamp < publicMinerRewardStartTimestamp) {
      return true;
    }

    const minerPeer = normalizePeer(block.miner_peer);
    const expectedWallet = trustedMinerRewardWallets.get(minerPeer);
    return Boolean(expectedWallet && block.transactions?.[0]?.recipient === expectedWallet);
  });
}

async function validateDiscoveredPeer(peer, knownMinerPeers) {
  const result = await requestChain(peer, 2500);
  if (!result.online || !result.chain) {
    return false;
  }

  const validation = validateChain(result.chain);
  if (!validation.ok) {
    return false;
  }

  const trustedPeers = new Set([...knownMinerPeers, peer]);
  return chainHasOnlyKnownMinerPeers(result.chain, trustedPeers);
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
        if (!discovered.has(peer) && (await validateDiscoveredPeer(peer, discovered))) {
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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function amountsEqual(left, right) {
  return Math.abs(left - right) <= amountEpsilon;
}

function allowedMiningRewardForBlock(index, circulatingSupply) {
  if (circulatingSupply >= maxCoinSupply) {
    return 0;
  }

  const halvings = Math.floor((index - 1) / halvingInterval);
  const reward = initialMiningReward / 2 ** halvings;
  return Math.min(reward, maxCoinSupply - circulatingSupply);
}

function validateGenesisBlock(block) {
  const [transaction] = Array.isArray(block?.transactions) ? block.transactions : [];
  return (
    block?.index === 0 &&
    block.timestamp === genesisTimestamp &&
    block.difficulty === 4 &&
    block.previous_hash === '0' &&
    block.hash === genesisBlockHash &&
    block.nonce === 19850 &&
    block.transactions.length === 1 &&
    transaction?.sender === 'network' &&
    transaction.recipient === 'genesis' &&
    amountsEqual(transaction.amount, 0) &&
    (transaction.fee ?? 0) === 0 &&
    transaction.sender_public_key === '' &&
    transaction.signature === ''
  );
}

function validateNormalTransaction(transaction, blockTimestamp) {
  if (!transaction || transaction.sender === 'network' || !transaction.recipient) {
    return { ok: false, error: 'invalid transaction identity' };
  }
  if (!/^[0-9a-f]{64}$/i.test(transaction.sender_public_key ?? '')) {
    return { ok: false, error: 'invalid transaction public key' };
  }
  if (!/^[0-9a-f]{128}$/i.test(transaction.signature ?? '')) {
    return { ok: false, error: 'invalid transaction signature' };
  }

  const fee = transaction.fee ?? 0;
  if (!isFiniteNumber(fee) || fee < 0) {
    return { ok: false, error: 'invalid transaction fee' };
  }

  if (transaction.asset_operation) {
    return amountsEqual(transaction.amount, 0) && amountsEqual(fee, 0)
      ? { ok: true, fee: 0 }
      : { ok: false, error: 'asset transaction has XYQON amount or fee' };
  }

  if (!isFiniteNumber(transaction.amount) || transaction.amount <= 0) {
    return { ok: false, error: 'invalid transaction amount' };
  }
  if (blockTimestamp >= transactionFeeStartTimestamp && fee + amountEpsilon < defaultTransactionFee) {
    return { ok: false, error: 'transaction fee below active minimum' };
  }
  return { ok: true, fee };
}

function validateChain(chain) {
  if (!chain || !Array.isArray(chain.chain) || chain.chain.length === 0) {
    return { ok: false, error: 'missing chain' };
  }
  if (!isFiniteNumber(chain.circulating_supply)) {
    return { ok: false, error: 'missing circulating supply' };
  }
  if (!validateGenesisBlock(chain.chain[0])) {
    return { ok: false, error: 'invalid genesis block' };
  }

  let circulatingSupply = 0;
  for (let index = 1; index < chain.chain.length; index += 1) {
    const block = chain.chain[index];
    const previous = chain.chain[index - 1];
    if (block?.index !== index || !Number.isInteger(block.timestamp)) {
      return { ok: false, error: `invalid block ${index}` };
    }
    if (!Number.isInteger(block.difficulty) || block.difficulty < 1 || block.difficulty > 64) {
      return { ok: false, error: `invalid block ${index} difficulty` };
    }
    if (block.previous_hash !== previous.hash || !/^[0-9a-f]{64}$/i.test(block.hash ?? '')) {
      return { ok: false, error: `invalid block ${index} hash link` };
    }
    if (!block.hash.startsWith('0'.repeat(block.difficulty))) {
      return { ok: false, error: `block ${index} does not satisfy proof of work` };
    }
    if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
      return { ok: false, error: `block ${index} has no coinbase transaction` };
    }

    const [coinbase, ...transactions] = block.transactions;
    if (block.timestamp >= emptyRewardBlockRejectionStartTimestamp && transactions.length === 0) {
      return { ok: false, error: `block ${index} has no active transaction` };
    }
    if (
      coinbase?.sender !== 'network' ||
      !coinbase.recipient ||
      !isFiniteNumber(coinbase.amount) ||
      (coinbase.fee ?? 0) !== 0 ||
      coinbase.sender_public_key !== '' ||
      coinbase.signature !== ''
    ) {
      return { ok: false, error: `invalid block ${index} coinbase` };
    }

    let fees = 0;
    for (const transaction of transactions) {
      const validation = validateNormalTransaction(transaction, block.timestamp);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      fees += validation.fee;
    }

    const subsidy = allowedMiningRewardForBlock(index, circulatingSupply);
    if (!amountsEqual(coinbase.amount, subsidy + fees)) {
      return { ok: false, error: `invalid block ${index} reward` };
    }
    circulatingSupply += subsidy;
    if (circulatingSupply > maxCoinSupply + amountEpsilon) {
      return { ok: false, error: 'circulating supply exceeds maximum' };
    }
  }

  if (!amountsEqual(circulatingSupply, chain.circulating_supply)) {
    return { ok: false, error: 'circulating supply does not match chain' };
  }

  return { ok: true, error: null };
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
  const collections = new Map();
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
      } else if (operation.RegisterCollection) {
        const value = operation.RegisterCollection;
        const collection = normalizeSymbol(value.collection);
        collections.set(collection, {
          collection,
          creator: tx.sender_public_key,
          authorizedMinters: value.authorized_minters,
          metadataUrl: value.metadata_url ?? null,
          authorityMutable: value.authority_mutable,
          locked: false,
          registeredInBlock: block.index
        });
      } else if (operation.UpdateCollection) {
        const value = operation.UpdateCollection;
        const record = collections.get(normalizeSymbol(value.collection));
        if (record) {
          record.authorizedMinters = value.authorized_minters;
          record.metadataUrl = value.metadata_url ?? null;
        }
      } else if (operation.LockCollection) {
        const record = collections.get(normalizeSymbol(operation.LockCollection.collection));
        if (record) record.locked = true;
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
    collections: [...collections.values()].sort((a, b) => a.collection.localeCompare(b.collection)),
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
  const results = (await Promise.all(knownPeers.map((peer) => requestChain(peer)))).map((result) => {
    const validation = result.online ? validateChain(result.chain) : { ok: false, error: result.error };
    const minerPeersValid = validation.ok ? chainHasOnlyKnownMinerPeers(result.chain, new Set(knownPeers)) : false;
    const minerRewardsValid = validation.ok ? chainHasExpectedMinerRewards(result.chain) : false;
    return {
      ...result,
      chainValid: validation.ok && minerPeersValid && minerRewardsValid,
      validationError:
        validation.ok && !minerPeersValid
          ? 'Chain includes unknown public miner peer rewards'
          : validation.ok && !minerRewardsValid
            ? 'Chain includes public miner rewards paid to the wrong wallet'
            : validation.error
    };
  });

  const best = results
    .filter((result) => result.chainValid)
    .sort((a, b) => chainScore(b.chain) - chainScore(a.chain))[0];

  const activeTipHash = best?.chain?.chain.at(-1)?.hash ?? null;
  const nodes = results.map((result) => {
    const tipHash = result.chainValid ? result.chain.chain.at(-1)?.hash : null;
    const active = Boolean(activeTipHash && tipHash === activeTipHash);
    return {
      address: result.peer,
      online: active,
      latencyMs: result.latencyMs,
      blockHeight: result.chainValid ? result.chain.chain.length - 1 : null,
      chainScore: result.chainValid ? chainScore(result.chain) : 0,
      circulatingSupply: result.chainValid ? result.chain.circulating_supply : null,
      error: result.online ? (active ? null : result.validationError ?? 'Inactive chain tip') : result.error
    };
  });

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
    collections: assets.collections,
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
  const path = normalizeApiPath(url.pathname);
  if (path === '/api/dashboard') {
    try {
      await sendJson(response, 200, await getDashboard());
    } catch (error) {
      await sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (path.startsWith('/api/address/')) {
    await sendJson(response, 200, await getAddress(decodeURIComponent(path.slice('/api/address/'.length))));
    return;
  }

  if (path.startsWith('/api/block/')) {
    await sendJson(response, 200, await getBlock(decodeURIComponent(path.slice('/api/block/'.length))));
    return;
  }

  if (path.startsWith('/api/transaction/')) {
    await sendJson(
      response,
      200,
      await getTransaction(decodeURIComponent(path.slice('/api/transaction/'.length)))
    );
    return;
  }

  if (path === '/api/assets') {
    await sendJson(response, 200, await getAssets());
    return;
  }

  if (path === '/api/health') {
    await sendJson(response, 200, { ok: true });
    return;
  }

  await sendJson(response, 404, { error: 'Not found' });
}

function normalizeApiPath(pathname) {
  if (pathname === '/dashboard') {
    return '/api/dashboard';
  }
  if (pathname === '/health') {
    return '/api/health';
  }
  if (pathname === '/assets') {
    return '/api/assets';
  }
  for (const prefix of ['/address/', '/block/', '/transaction/']) {
    if (pathname.startsWith(prefix)) {
      return `/api${pathname}`;
    }
  }
  return pathname.replace(/^\/api\/api(?=\/|$)/, '/api');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(await getDashboard(), null, 2));
    return;
  }

  http.createServer(handleRequest).listen(port, '127.0.0.1', () => {
    console.log(`XYQON dashboard API listening on http://127.0.0.1:${port}`);
  });
}
