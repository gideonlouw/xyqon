#!/usr/bin/env node
import {
  DEFAULT_PEERS,
  DEFAULT_WALLET_PATH,
  createWallet,
  createCoin,
  discoverPeers,
  getBalance,
  getBestChain,
  loadWallet,
  mintNft,
  saveWallet,
  sendCoin,
  transferNft,
  sendTransaction
} from './index.js';

const colors = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m'
};

function color(name, text) {
  return `${colors[name]}${text}${colors.reset}`;
}

function printHero(title = 'XYQON Wallet') {
  console.log(color('cyan', '╔════════════════════════════════════════════════════╗'));
  console.log(color('cyan', `║ ${title.padEnd(50)} ║`));
  console.log(color('cyan', '╚════════════════════════════════════════════════════╝'));
}

function printHelp() {
  printHero('XYQON Client');
  console.log(`
${color('bold', 'Usage')}
  xyqon wallet new --name <NAME> [--out <FILE>]
  xyqon wallet show [--wallet <FILE>] [--private]
  xyqon balance [--wallet <FILE>] [--address <PUBLIC_KEY>]
  xyqon send --to <PUBLIC_KEY> --amount <AMOUNT> [--fee <AMOUNT>] [--wallet <FILE>]
  xyqon coin create --symbol <SYMBOL> --name <NAME> --supply <AMOUNT> [--wallet <FILE>]
  xyqon coin send --symbol <SYMBOL> --to <PUBLIC_KEY> --amount <AMOUNT> [--wallet <FILE>]
  xyqon nft mint --collection <SYMBOL> --token-id <ID> --name <NAME> [--image-url <URL>] [--wallet <FILE>]
  xyqon nft send --collection <SYMBOL> --token-id <ID> --to <PUBLIC_KEY> [--wallet <FILE>]
  xyqon nodes

${color('bold', 'Network options')}
  --peer <IP[:PORT]>    Add a seed peer. Can be repeated.

${color('bold', 'Defaults')}
  Wallet: ${DEFAULT_WALLET_PATH}
  Peers:  ${DEFAULT_PEERS.join(', ')}
`);
}

function parseArgs(argv) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      values._.push(item);
      continue;
    }

    const key = item.slice(2);
    if (key === 'private' || key === 'force') {
      values[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    index += 1;

    if (key === 'peer') {
      values.peer = [...(values.peer ?? []), value];
    } else {
      values[key] = value;
    }
  }

  return values;
}

function peersFromOptions(options) {
  return options.peer?.length ? options.peer : DEFAULT_PEERS;
}

async function run() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const subcommand = command === 'wallet' || command === 'coin' || command === 'nft' ? argv[1] : undefined;
  const rest = command === 'wallet' || command === 'coin' || command === 'nft' ? argv.slice(2) : argv.slice(1);
  const options = parseArgs(rest);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'wallet' && subcommand === 'new') {
    const path = options.out ?? DEFAULT_WALLET_PATH;
    const wallet = createWallet(options.name ?? 'XYQON User');
    await saveWallet(wallet, path);
    printHero('Wallet Created');
    console.log(`${color('green', 'Saved:')} ${path}`);
    console.log(`${color('green', 'Public key:')} ${wallet.public_key}`);
    console.log(color('yellow', 'Keep the wallet file private. It contains your private key.'));
    return;
  }

  if (command === 'wallet' && subcommand === 'show') {
    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    printHero('Wallet');
    console.log(`${color('bold', 'Name:')} ${wallet.name}`);
    console.log(`${color('bold', 'Public key:')} ${wallet.public_key}`);
    if (options.private) {
      console.log(`${color('red', 'Private key:')} ${wallet.private_key}`);
    }
    return;
  }

  if (command === 'balance') {
    const wallet = options.address ? null : await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const address = options.address ?? wallet.public_key;
    const balance = await getBalance(address, peersFromOptions(options));
    printHero('Balance');
    console.log(`${color('bold', 'Address:')} ${balance.address}`);
    console.log(`${color('green', 'Balance:')} ${balance.balance} XYQON`);
    console.log(`${color('dim', 'Block height:')} ${balance.blockHeight}`);
    console.log(`${color('dim', 'Source node:')} ${balance.sourcePeer}`);
    return;
  }

  if (command === 'send') {
    if (!options.to) {
      throw new Error('send requires --to <PUBLIC_KEY>');
    }
    if (!options.amount) {
      throw new Error('send requires --amount <AMOUNT>');
    }

    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const result = await sendTransaction({
      wallet,
      recipient: options.to,
      amount: options.amount,
      fee: options.fee,
      peers: peersFromOptions(options)
    });

    printHero('Transaction Sent');
    console.log(`${color('bold', 'Amount:')} ${result.transaction.amount} XYQON`);
    console.log(`${color('bold', 'Fee:')} ${result.transaction.fee} XYQON`);
    console.log(`${color('bold', 'To:')} ${result.transaction.recipient}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('dim', 'Checked balance:')} ${result.preflight.balance} XYQON at block ${result.preflight.blockHeight}`);
    console.log(`${color('green', 'Delivered:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    console.log(color('yellow', 'The receiver balance updates after a miner includes this transaction in a block.'));
    return;
  }

  if (command === 'coin' && subcommand === 'create') {
    if (!options.symbol) {
      throw new Error('coin create requires --symbol <SYMBOL>');
    }
    if (!options.name) {
      throw new Error('coin create requires --name <NAME>');
    }
    if (!options.supply) {
      throw new Error('coin create requires --supply <AMOUNT>');
    }

    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const result = await createCoin({
      wallet,
      symbol: options.symbol,
      name: options.name,
      supply: options.supply,
      peers: peersFromOptions(options)
    });

    printHero('Coin Created');
    console.log(`${color('bold', 'Symbol:')} ${result.transaction.asset_operation.CreateCoin.symbol}`);
    console.log(`${color('bold', 'Supply:')} ${result.transaction.asset_operation.CreateCoin.supply}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('green', 'Broadcast:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    console.log(color('yellow', 'The coin exists after a miner includes this transaction in a block.'));
    return;
  }

  if (command === 'coin' && subcommand === 'send') {
    if (!options.symbol) {
      throw new Error('coin send requires --symbol <SYMBOL>');
    }
    if (!options.to) {
      throw new Error('coin send requires --to <PUBLIC_KEY>');
    }
    if (!options.amount) {
      throw new Error('coin send requires --amount <AMOUNT>');
    }

    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const result = await sendCoin({
      wallet,
      recipient: options.to,
      symbol: options.symbol,
      amount: options.amount,
      peers: peersFromOptions(options)
    });

    printHero('Coin Sent');
    console.log(`${color('bold', 'Amount:')} ${result.transaction.asset_operation.TransferCoin.amount} ${result.transaction.asset_operation.TransferCoin.symbol}`);
    console.log(`${color('bold', 'To:')} ${result.transaction.recipient}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('dim', 'Checked balance:')} ${result.preflight.balance} ${result.preflight.symbol} at block ${result.preflight.blockHeight}`);
    console.log(`${color('green', 'Delivered:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    return;
  }

  if (command === 'nft' && subcommand === 'mint') {
    if (!options.collection) {
      throw new Error('nft mint requires --collection <SYMBOL>');
    }
    if (!options['token-id']) {
      throw new Error('nft mint requires --token-id <ID>');
    }
    if (!options.name) {
      throw new Error('nft mint requires --name <NAME>');
    }

    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const result = await mintNft({
      wallet,
      collection: options.collection,
      tokenId: options['token-id'],
      name: options.name,
      imageUrl: options['image-url'],
      peers: peersFromOptions(options)
    });

    printHero('NFT Minted');
    console.log(`${color('bold', 'NFT:')} ${result.transaction.asset_operation.MintNft.collection}:${result.transaction.asset_operation.MintNft.token_id}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('green', 'Broadcast:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    console.log(color('yellow', 'The NFT exists after a miner includes this transaction in a block.'));
    return;
  }

  if (command === 'nft' && subcommand === 'send') {
    if (!options.collection) {
      throw new Error('nft send requires --collection <SYMBOL>');
    }
    if (!options['token-id']) {
      throw new Error('nft send requires --token-id <ID>');
    }
    if (!options.to) {
      throw new Error('nft send requires --to <PUBLIC_KEY>');
    }

    const wallet = await loadWallet(options.wallet ?? DEFAULT_WALLET_PATH);
    const result = await transferNft({
      wallet,
      recipient: options.to,
      collection: options.collection,
      tokenId: options['token-id'],
      peers: peersFromOptions(options)
    });

    printHero('NFT Sent');
    console.log(`${color('bold', 'NFT:')} ${result.transaction.asset_operation.TransferNft.collection}:${result.transaction.asset_operation.TransferNft.token_id}`);
    console.log(`${color('bold', 'To:')} ${result.transaction.recipient}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('green', 'Broadcast:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    return;
  }

  if (command === 'nodes') {
    const peers = await discoverPeers(peersFromOptions(options));
    const { nodes, chain, sourcePeer } = await getBestChain(peers);
    printHero('Live Nodes');
    for (const node of nodes) {
      const icon = node.ok ? color('green', '●') : color('red', '●');
      console.log(`${icon} ${node.peer.padEnd(22)} ${node.ok ? `${node.latencyMs} ms` : node.error}`);
    }
    console.log('');
    console.log(`${color('bold', 'Height:')} ${chain.chain.at(-1)?.index ?? 0}`);
    console.log(`${color('bold', 'Supply:')} ${chain.circulating_supply} XYQON`);
    console.log(`${color('dim', 'Best source:')} ${sourcePeer}`);
    return;
  }

  throw new Error(`unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

run().catch((error) => {
  console.error(color('red', `Error: ${error.message}`));
  process.exit(1);
});
