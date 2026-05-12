#!/usr/bin/env node
import {
  DEFAULT_PEERS,
  DEFAULT_WALLET_PATH,
  createWallet,
  discoverPeers,
  getBalance,
  getBestChain,
  loadWallet,
  saveWallet,
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
  xyqon send --to <PUBLIC_KEY> --amount <AMOUNT> [--wallet <FILE>]
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
  const subcommand = command === 'wallet' ? argv[1] : undefined;
  const rest = command === 'wallet' ? argv.slice(2) : argv.slice(1);
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
      peers: peersFromOptions(options)
    });

    printHero('Transaction Sent');
    console.log(`${color('bold', 'Amount:')} ${result.transaction.amount} XYQON`);
    console.log(`${color('bold', 'To:')} ${result.transaction.recipient}`);
    console.log(`${color('bold', 'Transaction ID:')} ${result.transactionId}`);
    console.log(`${color('green', 'Broadcast:')} ${result.acceptedBy}/${result.peers.length} reachable nodes`);
    console.log(color('yellow', 'The receiver balance updates after a miner includes this transaction in a block.'));
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
