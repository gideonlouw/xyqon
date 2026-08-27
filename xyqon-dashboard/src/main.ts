import { Component, computed, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { CurrencyPipe, DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import type { Auth } from 'firebase/auth';
import type { DocumentReference, Firestore } from 'firebase/firestore';
import { dashboardApiBaseUrl, firebaseConfig } from './environments/firebase-config';

type Transaction = {
  sender: string;
  recipient: string;
  amount: number;
  sender_public_key: string;
  signature: string;
  asset_operation?: {
    CreateCoin?: { symbol: string; name: string; supply: number };
    TransferCoin?: { symbol: string; amount: number };
    RegisterCollection?: { collection: string; authorized_minters: string[]; metadata_url?: string; authority_mutable: boolean };
    UpdateCollection?: { collection: string; authorized_minters: string[]; metadata_url?: string };
    LockCollection?: { collection: string };
    MintNft?: { collection: string; token_id: string; name: string; image_url?: string };
    TransferNft?: { collection: string; token_id: string };
  };
};

type Block = {
  index: number;
  timestamp: number;
  difficulty: number;
  transactions: Transaction[];
  previous_hash: string;
  hash: string;
  nonce: number;
};

type NodeStatus = {
  address: string;
  online: boolean;
  latencyMs: number | null;
  blockHeight: number | null;
  chainScore: number;
  circulatingSupply: number | null;
  error: string | null;
};

type ExplorerTransaction = Transaction & {
  id: string;
  blockIndex: number;
  transactionIndex: number;
  timestamp: number;
  isCoinbase: boolean;
};

type AddressBalance = {
  address: string;
  balance: number;
  mined: number;
  received: number;
  sent: number;
  transactions: number;
};

type CoinAsset = {
  symbol: string;
  name: string;
  supply: number;
  transactions: number;
  holders: { address: string; balance: number }[];
};

type NftAsset = {
  collection: string;
  tokenId: string;
  name: string;
  imageUrl: string | null;
  owner: string;
  mintedInBlock: number;
  lastTransferBlock: number | null;
};

type CollectionAsset = {
  collection: string;
  creator: string;
  authorizedMinters: string[];
  metadataUrl: string | null;
  authorityMutable: boolean;
  locked: boolean;
  registeredInBlock: number;
};

type DashboardResponse = {
  generatedAt: string;
  sourceNode: string | null;
  knownPeers: string[];
  nodes: NodeStatus[];
  chain: {
    blockHeight: number;
    blockCount: number;
    circulatingSupply: number;
    lastBlockHash: string | null;
    lastBlockTime: string | null;
  };
  richList: AddressBalance[];
  publicAddresses: AddressBalance[];
  coins: CoinAsset[];
  collections: CollectionAsset[];
  nfts: NftAsset[];
  recentBlocks: Block[];
  recentTransactions: ExplorerTransaction[];
};

type FirebaseUser = {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
};

type FirebaseRuntime = {
  auth: Auth;
  db: Firestore;
  GoogleAuthProvider: typeof GoogleAuthProvider;
  onAuthStateChanged: (auth: Auth, callback: (user: FirebaseUser | null) => void) => void;
  signInWithPopup: (auth: Auth, provider: InstanceType<typeof GoogleAuthProvider>) => Promise<{ user: FirebaseUser }>;
  signOut: (auth: Auth) => Promise<void>;
  doc: (db: Firestore, collectionName: string, documentId: string) => DocumentReference;
  setDoc: (reference: DocumentReference, data: Record<string, unknown>, options: { merge: boolean }) => Promise<void>;
  serverTimestamp: () => unknown;
};

type Page = 'home' | 'run-a-node' | 'dashboard' | 'explorer' | 'community' | 'developers' | 'clothing';

type TranslationLanguage = {
  code: string;
  name: string;
};

type SeoConfig = {
  title: string;
  description: string;
  path: string;
  index: boolean;
};

type ClothingProduct = {
  id: string;
  name: string;
  category: string;
  priceUsd: number;
  mockupClass: string;
};

type ClothingSize = 'S' | 'M' | 'L' | 'XL' | 'XXL';

type ClothingOrderDraft = {
  size: ClothingSize;
  transactionHash: string;
  deliveryAddress: string;
};

const firebaseRuntime = loadFirebaseRuntime();

const translationLanguages: TranslationLanguage[] = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'sq', name: 'Albanian' },
  { code: 'am', name: 'Amharic' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'as', name: 'Assamese' },
  { code: 'ay', name: 'Aymara' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'bm', name: 'Bambara' },
  { code: 'eu', name: 'Basque' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bho', name: 'Bhojpuri' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'ceb', name: 'Cebuano' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'co', name: 'Corsican' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'dv', name: 'Dhivehi' },
  { code: 'doi', name: 'Dogri' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'eo', name: 'Esperanto' },
  { code: 'et', name: 'Estonian' },
  { code: 'ee', name: 'Ewe' },
  { code: 'fil', name: 'Filipino' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'fy', name: 'Frisian' },
  { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'gn', name: 'Guarani' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'ht', name: 'Haitian Creole' },
  { code: 'ha', name: 'Hausa' },
  { code: 'haw', name: 'Hawaiian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hmn', name: 'Hmong' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' },
  { code: 'ig', name: 'Igbo' },
  { code: 'ilo', name: 'Ilocano' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'jv', name: 'Javanese' },
  { code: 'kn', name: 'Kannada' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'km', name: 'Khmer' },
  { code: 'rw', name: 'Kinyarwanda' },
  { code: 'ko', name: 'Korean' },
  { code: 'kri', name: 'Krio' },
  { code: 'ku', name: 'Kurdish (Kurmanji)' },
  { code: 'ckb', name: 'Kurdish (Sorani)' },
  { code: 'ky', name: 'Kyrgyz' },
  { code: 'lo', name: 'Lao' },
  { code: 'la', name: 'Latin' },
  { code: 'lv', name: 'Latvian' },
  { code: 'ln', name: 'Lingala' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lg', name: 'Luganda' },
  { code: 'lb', name: 'Luxembourgish' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'mai', name: 'Maithili' },
  { code: 'mg', name: 'Malagasy' },
  { code: 'ms', name: 'Malay' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mt', name: 'Maltese' },
  { code: 'mi', name: 'Maori' },
  { code: 'mr', name: 'Marathi' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'my', name: 'Myanmar (Burmese)' },
  { code: 'ne', name: 'Nepali' },
  { code: 'no', name: 'Norwegian' },
  { code: 'ny', name: 'Nyanja' },
  { code: 'or', name: 'Odia' },
  { code: 'om', name: 'Oromo' },
  { code: 'ps', name: 'Pashto' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'qu', name: 'Quechua' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sm', name: 'Samoan' },
  { code: 'sa', name: 'Sanskrit' },
  { code: 'gd', name: 'Scots Gaelic' },
  { code: 'nso', name: 'Sepedi' },
  { code: 'sr', name: 'Serbian' },
  { code: 'st', name: 'Sesotho' },
  { code: 'sn', name: 'Shona' },
  { code: 'sd', name: 'Sindhi' },
  { code: 'si', name: 'Sinhala' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'so', name: 'Somali' },
  { code: 'es', name: 'Spanish' },
  { code: 'su', name: 'Sundanese' },
  { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' },
  { code: 'tg', name: 'Tajik' },
  { code: 'ta', name: 'Tamil' },
  { code: 'tt', name: 'Tatar' },
  { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' },
  { code: 'ti', name: 'Tigrinya' },
  { code: 'ts', name: 'Tsonga' },
  { code: 'tr', name: 'Turkish' },
  { code: 'tk', name: 'Turkmen' },
  { code: 'ak', name: 'Twi' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ug', name: 'Uyghur' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'cy', name: 'Welsh' },
  { code: 'xh', name: 'Xhosa' },
  { code: 'yi', name: 'Yiddish' },
  { code: 'yo', name: 'Yoruba' },
  { code: 'zu', name: 'Zulu' }
];

const seoByPage: Record<Page, SeoConfig> = {
  home: { title: 'XYQON | Open Blockchain Network', description: 'Discover XYQON, run an independent blockchain node, inspect the live network, or build wallets, coins, NFTs, and apps with JavaScript.', path: '/', index: true },
  'run-a-node': { title: 'Run a XYQON Node | Linux Setup Guide', description: 'Join the XYQON peer-to-peer network with this practical Linux node setup guide, including ports, peers, synchronization, and mining preparation.', path: '/run-a-node', index: true },
  developers: { title: 'Build with JavaScript | XYQON Developer Guide', description: 'Install the XYQON npm client, create a wallet, receive funds, send a transaction, and build coins, NFTs, games, and community tools.', path: '/developers', index: true },
  dashboard: { title: 'Live XYQON Network Dashboard', description: 'Monitor live XYQON nodes, consensus height, circulating supply, recent blocks, public addresses, coins, NFTs, and network activity.', path: '/dashboard', index: true },
  explorer: { title: 'XYQON Block Explorer', description: 'Search the XYQON blockchain by public address, block height, block hash, or transaction ID and inspect recent confirmed activity.', path: '/explorer', index: true },
  community: { title: 'Join the XYQON Community', description: 'Meet XYQON node operators, miners, builders, testers, and contributors and join the public community on Discord and GitHub.', path: '/community', index: true },
  clothing: { title: 'XYQON Community Merchandise', description: 'Community merchandise for XYQON supporters.', path: '/clothing', index: false }
};

@Component({
  selector: 'app-root',
  imports: [CurrencyPipe, DecimalPipe, DatePipe, NgClass],
  template: `
    <main class="app-shell">
      <nav class="site-nav" aria-label="Primary">
        <a href="/" class="brand" (click)="navigate($event, 'home')">
          <span class="brand-mark"><img src="/assets/xyqon-logo-small.png" alt="" /></span>
          <span>Xyqon</span>
        </a>
        <div class="nav-links">
          <a href="/run-a-node" (click)="navigate($event, 'run-a-node')">Run a Node</a>
          <a href="/developers" (click)="navigate($event, 'developers')">Build with JavaScript</a>
          <a href="/dashboard" (click)="navigate($event, 'dashboard')">Dashboard</a>
          <a href="/explorer" (click)="navigate($event, 'explorer')">Block Explorer</a>
          <a href="/community" (click)="navigate($event, 'community')">Community</a>
        </div>
      </nav>

      <section class="language-bar" aria-label="Language translation">
        <div>
          <strong>Read XYQON in your language</strong>
          <span>Translate the page you are viewing with Google Translate.</span>
        </div>
        <label>
          <span class="visually-hidden">Choose a language</span>
          <select (change)="translatePage($event)" aria-label="Choose a language to translate this page">
            <option value="" selected>Choose a language</option>
            @for (language of translationLanguages; track language.code) {
              <option [value]="language.code">{{ language.name }}</option>
            }
          </select>
        </label>
      </section>

      @if (page() === 'home') {
        <section class="landing-grid">
          <div class="landing-copy">
            <img class="landing-logo" src="/assets/xyqon-logo.png" alt="Xyqon logo" />
            <p class="eyebrow">XYQON Network</p>
            <h1>Xyqon is a community-built blockchain project for open network participation.</h1>
            <p>
              Follow live nodes, inspect recent blocks, explore public addresses, and join the community
              that helps test, improve, and grow the project.
            </p>
            <div class="hero-actions">
              <a class="primary-action" href="/run-a-node" (click)="navigate($event, 'run-a-node')">Run a Node</a>
              <a class="secondary-action" href="/developers" (click)="navigate($event, 'developers')">Build with JavaScript</a>
            </div>
            <div class="supporting-actions">
              <a href="/dashboard" (click)="navigate($event, 'dashboard')">View network dashboard</a>
              <a href="/explorer" (click)="navigate($event, 'explorer')">Open block explorer</a>
            </div>
          </div>
          <aside class="network-card" aria-label="Network snapshot">
            <span>Current Network</span>
            @if (dashboard(); as data) {
              <strong>{{ data.chain.blockHeight | number }}</strong>
              <p>latest block height</p>
              <div class="snapshot-row">
                <span>Online nodes</span>
                <b>{{ onlineNodes() }} / {{ data.nodes.length }}</b>
              </div>
              <div class="snapshot-row">
                <span>Known addresses</span>
                <b>{{ data.publicAddresses.length | number }}</b>
              </div>
            } @else {
              <strong>Live</strong>
              <p>loading network snapshot</p>
            }
          </aside>
        </section>

        <section class="public-links" aria-label="Public project links">
          <article>
            <h2>Run a Node</h2>
            <p>Join the peer network, synchronize the chain, and improve XYQON's provider and geographic resilience.</p>
            <a href="/run-a-node" (click)="navigate($event, 'run-a-node')">Open node guide</a>
          </article>
          <article>
            <h2>Build with JavaScript</h2>
            <p>Create wallets, send transactions, and build coins, NFTs, games, and community tools with npm.</p>
            <a href="/developers" (click)="navigate($event, 'developers')">Start five-minute tutorial</a>
          </article>
          <article>
            <h2>Live Dashboard</h2>
            <p>See public node health, block height, circulating supply, recent blocks, coins, NFTs, and rich-list data.</p>
            <a href="/dashboard" (click)="navigate($event, 'dashboard')">View dashboard</a>
          </article>
          <article>
            <h2>Community</h2>
            <p>Join builders, node operators, testers, and contributors helping the public network grow.</p>
            <a href="/community" (click)="navigate($event, 'community')">Join community</a>
          </article>
        </section>

        <section class="node-callout" aria-label="Run a Xyqon node">
          <div class="section-head">
            <p class="eyebrow">RUN A NODE</p>
            <h2>Help secure and grow the XYQON network.</h2>
            <p>
              XYQON is a Rust blockchain node built for public peer participation, mining rewards,
              and live chain synchronization.
            </p>
          </div>
          <div class="node-grid">
            <ul>
              <li>Proof-of-work blocks</li>
              <li>Signed Ed25519 transactions</li>
              <li>Coinbase mining rewards</li>
              <li>67 million maximum coin supply</li>
              <li>60-second rolling-window difficulty target</li>
            </ul>
            <ul>
              <li>Persistent mempool for pending signed transactions</li>
              <li>Chain sync for late-joining peers</li>
              <li>Peer discovery through shared lists and announcements</li>
              <li>Fork resolution using accumulated work</li>
              <li>Balance validation to reject overspending</li>
              <li>TCP peer-to-peer block and transaction sharing</li>
            </ul>
          </div>
          <a class="primary-action" href="https://github.com/gideonlouw/xyqon#run-a-miner" target="_blank" rel="noopener">
            View Mining Guide
          </a>
        </section>

      }

      @if (page() === 'run-a-node') {
        <section class="page-intro node-guide-intro">
          <p class="eyebrow">RUN A XYQON NODE</p>
          <h1>Join the public peer network from your own Linux server.</h1>
          <p>Run a relay node first, synchronize the valid chain, and help make XYQON more resilient across providers and continents. Mining access is a separate approval step.</p>
          <div class="hero-actions">
            <a class="primary-action" href="https://github.com/gideonlouw/xyqon/releases/tag/v0.2.0" target="_blank" rel="noopener">Download signed 0.2.0 release</a>
            <a class="secondary-action" href="https://github.com/gideonlouw/xyqon/blob/main/docs/linux-live.md" target="_blank" rel="noopener">Open complete Linux guide</a>
          </div>
        </section>

        <section class="package-docs-layout node-guide" aria-label="XYQON Linux node setup">
          <aside class="package-summary">
            <h2>Before you start</h2>
            <ul>
              <li>A Linux server with a stable public IPv4 address</li>
              <li>Inbound TCP port <code>7101</code> open</li>
              <li>SSH and administrator access</li>
              <li>The official signed XYQON 0.2.0 binary</li>
              <li>Enough storage for the growing chain and mempool</li>
            </ul>
            <p>Never share a wallet file or private key. A normal relay node does not require a mining wallet.</p>
            <nav class="package-links" aria-label="Node operator links">
              <a href="https://github.com/gideonlouw/xyqon/releases/tag/v0.2.0" target="_blank" rel="noopener">Release downloads</a>
              <a href="https://github.com/gideonlouw/xyqon/blob/main/README.md#peer-list" target="_blank" rel="noopener">Peer documentation</a>
              <a href="https://github.com/gideonlouw/xyqon/discussions" target="_blank" rel="noopener">Ask the community</a>
            </nav>
          </aside>

          <article class="package-readme">
            <section>
              <span id="install" class="anchor-target" aria-hidden="true"></span>
              <h2>1. Install the verified binary</h2>
              <p>Download the archive, checksum, signature, and certificate for your operating system from the official release. Verify them before installation.</p>
              <pre><code>sudo install -m 0755 xyqon /usr/local/bin/xyqon
xyqon --help</code></pre>
            </section>

            <section>
              <span id="storage" class="anchor-target" aria-hidden="true"></span>
              <h2>2. Prepare node storage</h2>
              <pre><code>sudo mkdir -p /etc/xyqon /var/lib/xyqon
sudo chown -R $USER:$USER /etc/xyqon /var/lib/xyqon</code></pre>
              <p>For a long-running public service, use a dedicated unprivileged <code>xyqon</code> system user as described in the complete Linux guide.</p>
            </section>

            <section>
              <span id="peers" class="anchor-target" aria-hidden="true"></span>
              <h2>3. Add trusted seed peers</h2>
              <p>Create <code>/etc/xyqon/peers.txt</code> with one peer per line:</p>
              <pre><code>68.183.98.134:7101
143.244.149.8:7101
147.182.138.183:7101</code></pre>
              <p>Your node will synchronize from these peers, announce itself, and discover other valid XYQON nodes.</p>
            </section>

            <section>
              <span id="firewall" class="anchor-target" aria-hidden="true"></span>
              <h2>4. Open the network port</h2>
              <pre><code>sudo ufw allow 7101/tcp
sudo ufw status</code></pre>
              <p>Also allow inbound TCP 7101 in your cloud firewall or security group.</p>
            </section>

            <section>
              <span id="start" class="anchor-target" aria-hidden="true"></span>
              <h2>5. Start as a relay node</h2>
              <pre><code>xyqon node --listen 0.0.0.0:7101 --advertise YOUR_PUBLIC_IP:7101 --peers-file /etc/xyqon/peers.txt --trusted-miners-file /etc/xyqon/trusted-miners.json --chain /var/lib/xyqon/xyqon-chain.json</code></pre>
              <p>Replace <code>YOUR_PUBLIC_IP</code> with the server's stable public IPv4 address. Keep the process running with the systemd service from the complete guide.</p>
            </section>

            <section>
              <span id="verify" class="anchor-target" aria-hidden="true"></span>
              <h2>6. Verify synchronization</h2>
              <pre><code>ss -ltnp | grep 7101</code></pre>
              <p>Compare your block height and tip with the <a href="/dashboard" (click)="navigate($event, 'dashboard')">live network dashboard</a>. Your node should remain online and agree with the active chain before requesting miner approval.</p>
            </section>

            <section>
              <span id="mining" class="anchor-target" aria-hidden="true"></span>
              <h2>Want to mine?</h2>
              <p>First operate a stable relay node. Then share only your public node address and public reward wallet with the community. A current trusted miner must validate and sign the approval before reward blocks from the new miner are accepted.</p>
              <a class="primary-action" href="https://github.com/gideonlouw/xyqon#add-a-public-miner" target="_blank" rel="noopener">Read miner approval steps</a>
            </section>
          </article>
        </section>
      }

      @if (page() === 'developers') {
        <section class="page-intro">
          <p class="eyebrow">DEVELOPERS</p>
          <h1>Build applications, coins, and NFTs on top of the XYQON network.</h1>
          <p>Use the JavaScript client to create wallets, submit signed transactions, read balances, and build community tools around public nodes.</p>
        </section>
        <section class="developers" id="developers">
          <div class="developer-grid">
            <article>
              <span>Install</span>
              <code>npm install xyqon</code>
              <p>Use the JavaScript client in Node.js apps, tools, games, marketplaces, and community experiments.</p>
            </article>
            <article>
              <span>Applications</span>
              <code>import {{ '{' }} createWallet, getBalance, sendTransaction {{ '}' }} from 'xyqon';</code>
              <p>Create wallets, read live balances from public nodes, and sign transactions from your own app logic.</p>
            </article>
            <article>
              <span>Coins</span>
              <code>await createCoin({{ '{' }} wallet, symbol: 'GAME', name: 'Game Coin', supply: 1000000 {{ '}' }});</code>
              <p>Launch project tokens, then transfer balances between XYQON public keys after they are mined on-chain.</p>
            </article>
            <article>
              <span>NFTs</span>
              <code>await mintNft({{ '{' }} wallet, collection: 'ITEMS', tokenId: 'sword-001', name: 'Iron Sword' {{ '}' }});</code>
              <p>Mint collectibles, game items, art, or membership badges and transfer ownership through signed transactions.</p>
            </article>
          </div>

          <section class="quickstart" aria-labelledby="quickstart-title">
            <header>
              <p class="eyebrow">FIVE-MINUTE QUICKSTART</p>
              <h2 id="quickstart-title">Create a wallet, receive XYQON, and send your first transaction.</h2>
              <p>Node.js 20 or newer is the only prerequisite. Your wallet file contains your private key—keep it private and never share it.</p>
            </header>
            <ol class="quickstart-steps">
              <li>
                <div><span>1</span><strong>Install client 0.6.0</strong></div>
                <pre><code>npm install -g xyqon&#64;0.6.0</code></pre>
              </li>
              <li>
                <div><span>2</span><strong>Create your wallet</strong></div>
                <pre><code>xyqon wallet new --name "Your name"</code></pre>
                <p>This creates <code>xyqon.wallet.json</code> in the current directory.</p>
              </li>
              <li>
                <div><span>3</span><strong>Copy your public address</strong></div>
                <pre><code>xyqon wallet show</code></pre>
                <p>Share only the public key with an existing holder who can send you test funds.</p>
              </li>
              <li>
                <div><span>4</span><strong>Confirm the funds arrived</strong></div>
                <pre><code>xyqon balance</code></pre>
                <p>A miner must include the incoming transaction before the balance is confirmed.</p>
              </li>
              <li>
                <div><span>5</span><strong>Send your first transaction</strong></div>
                <pre><code>xyqon send \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 0.5</code></pre>
                <p>The client verifies that a reachable node reports the transaction as pending or confirmed.</p>
              </li>
            </ol>
          </section>

          <section class="package-docs" aria-labelledby="package-docs-title">
            <header class="package-docs-header">
              <div>
                <p class="eyebrow">NPM PACKAGE</p>
                <h2 id="package-docs-title">XYQON Client</h2>
                <p>Friendly wallet CLI and JavaScript client for the live XYQON network.</p>
              </div>
              <a class="secondary-action" href="https://www.npmjs.com/package/xyqon" target="_blank" rel="noopener">
                View on npm
              </a>
            </header>

            <div class="package-docs-layout">
              <aside class="package-summary" aria-label="Package details">
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>0.6.0</dd>
                  </div>
                  <div>
                    <dt>License</dt>
                    <dd>MIT</dd>
                  </div>
                  <div>
                    <dt>Node.js</dt>
                    <dd>20 or newer</dd>
                  </div>
                </dl>

                <h3>What it can do</h3>
                <ul>
                  <li>Generate a new XYQON wallet</li>
                  <li>Show your public key</li>
                  <li>Check balances from live public nodes</li>
                  <li>Send signed transactions</li>
                  <li>Create and send coins</li>
                  <li>Mint and transfer NFTs</li>
                  <li>Show currently reachable nodes</li>
                </ul>
                <p>You do not need to mine or run a full node.</p>

                <nav class="package-links" aria-label="Package links">
                  <a href="https://github.com/gideonlouw/xyqon" target="_blank" rel="noopener">Repository</a>
                  <a href="https://github.com/gideonlouw/xyqon/issues" target="_blank" rel="noopener">Report an issue</a>
                </nav>
              </aside>

              <article class="package-readme">
                <section>
                  <h3>Install</h3>
                  <pre><code>npm install -g xyqon</code></pre>
                  <p>Or run the command-line client without installing it globally:</p>
                  <pre><code>npx xyqon help</code></pre>
                </section>

                <section>
                  <h3>Create a wallet</h3>
                  <pre><code>xyqon wallet new --name Cathy</code></pre>
                  <p>This creates <code>xyqon.wallet.json</code>. Keep this file private because it contains your private key.</p>
                </section>

                <section>
                  <h3>Show your address</h3>
                  <pre><code>xyqon wallet show</code></pre>
                </section>

                <section>
                  <h3>Check balance</h3>
                  <pre><code>xyqon balance</code></pre>
                  <p>Use a custom wallet path:</p>
                  <pre><code>xyqon balance --wallet ./cathy.wallet.json</code></pre>
                </section>

                <section>
                  <h3>Send XYQON</h3>
                  <pre><code>xyqon send \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 1</code></pre>
                  <p>The transaction is broadcast to reachable public nodes. A miner must include it in a block before the receiver sees the confirmed balance.</p>
                  <p>The client checks the best reachable public chain before broadcasting and refuses sends that exceed the wallet's confirmed XYQON balance.</p>
                </section>

                <section>
                  <h3>Create and send coins</h3>
                  <pre><code>xyqon coin create \
  --symbol GAME \
  --name "Game Coin" \
  --supply 1000000

xyqon coin send \
  --symbol GAME \
  --to RECIPIENT_PUBLIC_KEY \
  --amount 25</code></pre>
                  <p>Coin creation and coin sends are signed 0 XYQON transactions. A miner must include them before the new coin or transfer appears on-chain.</p>
                  <p>Before broadcasting a coin transfer, the client checks the best reachable public chain and refuses sends that exceed the wallet's confirmed coin balance.</p>
                </section>

                <section>
                  <h3>Mint and send NFTs</h3>
                  <pre><code>xyqon nft mint \
  --collection ITEMS \
  --token-id sword-001 \
  --name "Iron Sword" \
  --image-url https://example.com/iron-sword.png

xyqon nft send \
  --collection ITEMS \
  --token-id sword-001 \
  --to RECIPIENT_PUBLIC_KEY</code></pre>
                </section>

                <section>
                  <h3>Show nodes</h3>
                  <pre><code>xyqon nodes</code></pre>
                </section>

                <section>
                  <h3>Seed nodes</h3>
                  <p>The package starts with these seed nodes:</p>
                  <pre><code>68.183.98.134:7101
143.244.149.8:7101
147.182.138.183:7101</code></pre>
                  <p>You can override them:</p>
                  <pre><code>xyqon balance --peer 68.183.98.134:7101 --peer 143.244.149.8:7101</code></pre>
                </section>

                <section>
                  <h3>JavaScript usage</h3>
                  <pre><code>import &#123;
  createWallet,
  loadWallet,
  getBalance,
  sendTransaction,
  createCoin,
  sendCoin,
  mintNft,
  transferNft,
  getCreatedCoins,
  getCreatedNfts,
  getOwnedNfts,
  getCoinHoldings
&#125; from 'xyqon';

const wallet = createWallet('Cathy');
console.log(wallet.public_key);

const balance = await getBalance(wallet.public_key);
console.log(balance);

await sendTransaction(&#123;
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  amount: 1
&#125;);

await createCoin(&#123;
  wallet,
  symbol: 'GAME',
  name: 'Game Coin',
  supply: 1000000
&#125;);

await sendCoin(&#123;
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  symbol: 'GAME',
  amount: 25
&#125;);

await mintNft(&#123;
  wallet,
  collection: 'ITEMS',
  tokenId: 'sword-001',
  name: 'Iron Sword',
  imageUrl: 'https://example.com/iron-sword.png'
&#125;);

await transferNft(&#123;
  wallet,
  recipient: 'RECIPIENT_PUBLIC_KEY',
  collection: 'ITEMS',
  tokenId: 'sword-001'
&#125;);

const createdCoins = await getCreatedCoins(wallet);
const createdNfts = await getCreatedNfts(wallet);
const ownedNfts = await getOwnedNfts(wallet);
const coinHoldings = await getCoinHoldings(wallet);</code></pre>
                </section>
              </article>
            </div>
          </section>
        </section>
      }

      @if (page() === 'clothing') {
        <section class="page-intro shop-intro">
          <div>
            <p class="eyebrow">XYQON CLOTHING</p>
            <h1>Wear the network.</h1>
            <p>Choose your item and size, then send one USDT payment for the item plus delivery to the address below.</p>
          </div>
          <aside class="payment-card">
            <span>USDT payment address</span>
            <strong class="mono wrap">{{ usdtAddress }}</strong>
            <p>Please include the clothing price and delivery fee together in the same payment.</p>
            <p>After payment, submit your delivery address and transaction hash with the item below.</p>
          </aside>
        </section>

        <section class="shop-summary" aria-label="Pricing">
          <article>
            <span>Hooded sweaters</span>
            <strong>{{ hoodiePriceUsd | currency:'USD':'symbol':'1.2-2' }}</strong>
          </article>
          <article>
            <span>T-shirts</span>
            <strong>{{ tshirtPriceUsd | currency:'USD':'symbol':'1.2-2' }}</strong>
          </article>
          <article>
            <span>Delivery</span>
            <strong>{{ deliveryUsd | currency:'USD':'symbol':'1.2-2' }}</strong>
          </article>
        </section>

        <section class="product-grid" aria-label="Xyqon clothing products">
          @for (product of clothingProducts; track product.id) {
            <article class="product-card">
              <div class="product-art" [ngClass]="product.mockupClass">
                <div class="garment">
                  @if (product.category === 'Hooded sweater') {
                    <span class="hoodie-strings"></span>
                    <span class="hoodie-pocket"></span>
                  }
                  <img src="/assets/xyqon-logo.png" alt="Xyqon logo" />
                </div>
              </div>
              <div class="product-info">
                <span>{{ product.category }}</span>
                <h2>{{ product.name }}</h2>
                <strong>{{ product.priceUsd | currency:'USD':'symbol':'1.2-2' }}</strong>
                <p class="total-note">
                  Pay {{ product.priceUsd + deliveryUsd | currency:'USD':'symbol':'1.2-2' }} total including delivery.
                </p>
                <div class="size-picker" aria-label="Select size">
                  @for (size of clothingSizes; track size) {
                    <button
                      type="button"
                      [class.selected]="selectedSize(product.id) === size"
                      (click)="selectSize(product.id, size)"
                    >
                      {{ size }}
                    </button>
                  }
                </div>
                <p>Selected size: <b>{{ selectedSize(product.id) }}</b></p>
                @if (user()) {
                  <form class="order-form" (submit)="submitClothingOrder($event, product)">
                    <label>
                      Transaction hash
                      <input
                        type="text"
                        placeholder="Paste your USDT transaction hash"
                        [value]="orderDraft(product.id).transactionHash"
                        (input)="updateOrderField(product.id, 'transactionHash', $any($event.target).value)"
                      >
                    </label>
                    <label>
                      Delivery address
                      <textarea
                        rows="3"
                        placeholder="Name, phone number, street address, city, postal code"
                        [value]="orderDraft(product.id).deliveryAddress"
                        (input)="updateOrderField(product.id, 'deliveryAddress', $any($event.target).value)"
                      ></textarea>
                    </label>
                    <button type="submit" class="primary-action" [disabled]="orderBusy()">
                      {{ orderBusy() ? 'Saving...' : 'Submit Order' }}
                    </button>
                  </form>
                } @else {
                  <div class="signin-required">
                    <p>Sign in with Google to submit clothing orders and delivery details.</p>
                    <button type="button" class="primary-action" (click)="joinWithGoogle()" [disabled]="authBusy()">
                      {{ authBusy() ? 'Opening Google...' : 'Sign In To Order' }}
                    </button>
                  </div>
                }
              </div>
            </article>
          }
        </section>
        @if (orderMessage()) {
          <div class="order-popup-backdrop" role="presentation">
            <section class="order-popup" role="alertdialog" aria-live="polite" aria-label="Clothing order message">
              <span>Clothing order</span>
              <p>{{ orderMessage() }}</p>
              <button type="button" class="primary-action" (click)="orderMessage.set(null)">Close</button>
            </section>
          </div>
        }
      }

      @if (page() === 'community') {
        <section class="community-layout">
          <div>
            <p class="eyebrow">Xyqon Community</p>
            <h1>Join the builders, testers, node operators, and early supporters around Xyqon.</h1>
            <p>
              Google sign-in creates your community member entry so the project can keep track
              of people who want to help with testing, docs, nodes, explorer feedback, and ecosystem ideas.
            </p>
            <div class="hero-actions">
              @if (user(); as activeUser) {
                <button type="button" class="primary-action" (click)="registerMember()" [disabled]="authBusy()">
                  {{ authBusy() ? 'Saving...' : 'Sync Profile' }}
                </button>
                <button type="button" class="secondary-action" (click)="leave()" [disabled]="authBusy()">Sign Out</button>
              } @else {
                <button type="button" class="primary-action" (click)="joinWithGoogle()" [disabled]="authBusy()">
                  {{ authBusy() ? 'Opening Google...' : 'Sign In With Google' }}
                </button>
              }
            </div>
            @if (communityMessage()) {
              <p class="community-message">{{ communityMessage() }}</p>
            }
          </div>
          <aside class="member-card">
            @if (user(); as activeUser) {
              <span>Community profile</span>
              <strong>{{ activeUser.displayName || 'Community member' }}</strong>
              <p>{{ activeUser.email }}</p>
              <div class="member-status">Active member</div>
              <p>Your profile is connected. Use Sync Profile if your Google name or email changes.</p>
              @if (discordCommunityUrl) {
                <a class="discord-community-link" [href]="discordCommunityUrl" target="_blank" rel="noopener noreferrer">
                  Join the Discord community
                </a>
              }
            } @else {
              <span>Membership</span>
              <strong>Google sign-in required</strong>
              <p>The dashboard and block explorer remain public. Sign-in is only for community contribution records.</p>
            }
          </aside>
        </section>
      }

      @if (page() === 'dashboard' || page() === 'explorer') {
        <header class="topbar">
          <div>
            <p class="eyebrow">XYQON Network</p>
            <h1>{{ page() === 'explorer' ? 'Public Block Explorer' : 'Live Node Dashboard' }}</h1>
          </div>
          <button type="button" class="refresh" (click)="load()" [disabled]="loading()">
            {{ loading() ? 'Refreshing' : 'Refresh' }}
          </button>
        </header>

        @if (error()) {
          <section class="notice">{{ error() }}</section>
        }

        @if (dashboard(); as data) {
          @if (page() === 'dashboard') {
            <section class="metrics" aria-label="Network summary">
              <article>
                <span>Block Height</span>
                <strong>{{ data.chain.blockHeight | number }}</strong>
              </article>
              <article>
                <span>Circulating Supply</span>
                <strong>{{ data.chain.circulatingSupply | number:'1.0-8' }}</strong>
              </article>
              <article>
                <span>Online Nodes</span>
                <strong>{{ onlineNodes() }} / {{ data.nodes.length }}</strong>
              </article>
              <article>
                <span>Known Addresses</span>
                <strong>{{ data.publicAddresses.length | number }}</strong>
              </article>
              <article>
                <span>Coins</span>
                <strong>{{ data.coins.length | number }}</strong>
              </article>
              <article>
                <span>NFTs</span>
                <strong>{{ data.nfts.length | number }}</strong>
              </article>
            </section>

            <section class="grid two">
              <div class="panel">
                <div class="panel-head">
                  <h2>Live Nodes</h2>
                  <span>Source: {{ data.sourceNode || 'none' }}</span>
                </div>
                <div class="table">
                  <div class="row header">
                    <span>Node</span>
                    <span>Status</span>
                    <span>Height</span>
                    <span>Latency</span>
                  </div>
                  @for (node of data.nodes; track node.address) {
                    <div class="row">
                      <span class="mono">{{ node.address }}</span>
                      <span>
                        <i [ngClass]="node.online ? 'up' : 'down'"></i>
                        {{ node.online ? 'Online' : 'Offline' }}
                      </span>
                      <span>{{ node.blockHeight ?? '-' }}</span>
                      <span>{{ node.latencyMs === null ? '-' : node.latencyMs + ' ms' }}</span>
                    </div>
                  }
                </div>
              </div>

              <div class="panel">
                <div class="panel-head">
                  <h2>Recent Blocks</h2>
                  <span>{{ data.generatedAt | date:'medium' }}</span>
                </div>
                <div class="blocks">
                  @for (block of data.recentBlocks; track block.hash) {
                    <article>
                      <div>
                        <strong>#{{ block.index }}</strong>
                        <span>{{ block.transactions.length }} tx</span>
                      </div>
                      <p class="mono">{{ block.hash }}</p>
                    </article>
                  }
                </div>
              </div>
            </section>
          }

          <section class="panel">
            <div class="panel-head">
              <h2>Explorer</h2>
              <span>Search by address, block height, block hash, or transaction id</span>
            </div>
            <div class="searchbar">
              <input
                type="search"
                placeholder="Paste address, block, or transaction"
                [value]="query()"
                (input)="query.set($any($event.target).value)"
              >
            </div>
            @if (query().trim()) {
              <div class="explorer-result">
                @if (matchedAddress(); as address) {
                  <article>
                    <span>Address</span>
                    <p class="mono wrap">{{ address.address }}</p>
                    <strong>{{ address.balance | number:'1.0-8' }} XYQON</strong>
                  </article>
                }
                @if (matchedBlock(); as block) {
                  <article>
                    <span>Block</span>
                    <p>#{{ block.index }} · {{ block.transactions.length }} transactions</p>
                    <strong class="mono wrap">{{ block.hash }}</strong>
                  </article>
                }
                @if (matchedTransaction(); as transaction) {
                  <article>
                    <span>Transaction</span>
                    <p>{{ transactionLabel(transaction) }} in block #{{ transaction.blockIndex }}</p>
                    <strong class="mono wrap">{{ transaction.id }}</strong>
                  </article>
                }
                @if (!matchedAddress() && !matchedBlock() && !matchedTransaction()) {
                  <article>
                    <span>No Match</span>
                    <p>Nothing in the current chain matches that value.</p>
                  </article>
                }
              </div>
            }
          </section>

          @if (page() === 'dashboard') {
            @if (data.collections.length) {
              <section class="panel">
                <div class="panel-head">
                  <h2>Registered NFT Collections</h2>
                  <span>{{ data.collections.length }} protected collections</span>
                </div>
                <div class="coin-list">
                  @for (collection of data.collections; track collection.collection) {
                    <article>
                      <div class="asset-title">
                        <div><strong>{{ collection.collection }}</strong><span>Creator</span></div>
                        <em>{{ collection.locked ? 'Locked' : (collection.authorityMutable ? 'Mutable' : 'Immutable') }}</em>
                      </div>
                      <p class="mono wrap">{{ collection.creator }}</p>
                      <div class="holders">
                        @for (minter of collection.authorizedMinters; track minter) {
                          <p><span class="mono wrap">Authorized minter: {{ minter }}</span></p>
                        }
                      </div>
                      @if (collection.metadataUrl) {
                        <p class="mono wrap">{{ collection.metadataUrl }}</p>
                      }
                    </article>
                  }
                </div>
              </section>
            }
            <section class="grid two assets-grid">
              <div class="panel">
                <div class="panel-head">
                  <h2>Network Coins</h2>
                  <span>{{ data.coins.length }} active symbols</span>
                </div>
                <div class="coin-list">
                  @for (coin of data.coins; track coin.symbol) {
                    <article>
                      <div class="asset-title">
                        <div>
                          <strong>{{ coin.symbol }}</strong>
                          <span>{{ coin.name }}</span>
                        </div>
                        <em>{{ coin.supply | number:'1.0-8' }}</em>
                      </div>
                      <div class="holders">
                        @for (holder of coin.holders.slice(0, 4); track holder.address) {
                          <p>
                            <span class="mono wrap">{{ holder.address }}</span>
                            <strong>{{ holder.balance | number:'1.0-8' }}</strong>
                          </p>
                        }
                        @if (!coin.holders.length) {
                          <p><span>No holders yet</span></p>
                        }
                      </div>
                    </article>
                  }
                  @if (!data.coins.length) {
                    <article class="empty-asset">No coins have been mined into the current chain yet.</article>
                  }
                </div>
              </div>

              <div class="panel">
                <div class="panel-head">
                  <h2>NFT Owners</h2>
                  <span>{{ data.nfts.length }} minted NFTs</span>
                </div>
                <div class="nft-list">
                  @for (nft of data.nfts; track nft.collection + ':' + nft.tokenId) {
                    <article [class.no-image]="!nft.imageUrl">
                      @if (nft.imageUrl) {
                        <img [src]="nft.imageUrl" [alt]="nft.name" loading="lazy">
                      }
                      <div>
                        <strong>{{ nft.collection }}:{{ nft.tokenId }}</strong>
                        <span>{{ nft.name }}</span>
                        <p class="mono wrap">{{ nft.owner }}</p>
                      </div>
                    </article>
                  }
                  @if (!data.nfts.length) {
                    <article class="empty-asset">No NFTs have been mined into the current chain yet.</article>
                  }
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Recent Transactions</h2>
                <span>{{ data.recentTransactions.length }} latest entries</span>
              </div>
              <div class="table transactions">
                <div class="row header">
                  <span>Type</span>
                  <span>Block</span>
                  <span>Recipient</span>
                  <span>Amount</span>
                </div>
                @for (transaction of data.recentTransactions; track transaction.id) {
                  <div class="row">
                    <span>{{ transactionType(transaction) }}</span>
                    <span>#{{ transaction.blockIndex }}</span>
                    <span class="mono wrap">{{ transaction.recipient }}</span>
                    <span>{{ transactionLabel(transaction) }}</span>
                  </div>
                }
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Rich List</h2>
                <span>Top balances from the current chain</span>
              </div>
              <div class="table addresses">
                <div class="row header">
                  <span>Rank</span>
                  <span>Public Address</span>
                  <span>Balance</span>
                  <span>Mined</span>
                  <span>Sent</span>
                  <span>Received</span>
                </div>
                @for (address of data.richList; track address.address; let index = $index) {
                  <div class="row">
                    <span>{{ index + 1 }}</span>
                    <span class="mono wrap">{{ address.address }}</span>
                    <span>{{ address.balance | number:'1.0-8' }}</span>
                    <span>{{ address.mined | number:'1.0-8' }}</span>
                    <span>{{ address.sent | number:'1.0-8' }}</span>
                    <span>{{ address.received | number:'1.0-8' }}</span>
                  </div>
                }
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Public Addresses</h2>
                <span>{{ data.publicAddresses.length }} seen on-chain</span>
              </div>
              <div class="address-list">
                @for (address of data.publicAddresses; track address.address) {
                  <article>
                    <p class="mono">{{ address.address }}</p>
                    <strong>{{ address.balance | number:'1.0-8' }} XYQON</strong>
                  </article>
                }
              </div>
            </section>
          }
        } @else {
          <section class="loading">Loading network data...</section>
        }
      }

      <footer class="site-footer">
        <span>XYQON is an open-source community network.</span>
        <nav aria-label="Secondary">
          <a href="https://github.com/gideonlouw/xyqon" target="_blank" rel="noopener">GitHub</a>
          <a href="https://www.npmjs.com/package/xyqon" target="_blank" rel="noopener">npm</a>
          <a href="/clothing" (click)="navigate($event, 'clothing')">Merch</a>
        </nav>
      </footer>
    </main>
  `
})
class App {
  private http = inject(HttpClient);
  dashboard = signal<DashboardResponse | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  query = signal('');
  page = signal<Page>(this.routeFromPath());
  user = signal<FirebaseUser | null>(null);
  authBusy = signal(false);
  orderBusy = signal(false);
  communityMessage = signal<string | null>(null);
  orderMessage = signal<string | null>(null);
  readonly discordCommunityUrl = 'https://discord.gg/Pz8HfhxX2';
  readonly translationLanguages = translationLanguages;
  readonly exchangeRate = 16.5;
  readonly usdtAddress = '0x2b7e15382b09f41024ee9a20d2cb7905f8b02785';
  readonly hoodiePriceUsd = 500 / this.exchangeRate;
  readonly tshirtPriceUsd = 200 / this.exchangeRate;
  readonly deliveryUsd = 300 / this.exchangeRate;
  readonly clothingSizes: ClothingSize[] = ['S', 'M', 'L', 'XL', 'XXL'];
  readonly clothingProducts: ClothingProduct[] = [
    { id: 'grey-hoodie', name: 'Grey Xyqon Hoodie', category: 'Hooded sweater', priceUsd: this.hoodiePriceUsd, mockupClass: 'hoodie grey' },
    { id: 'white-hoodie', name: 'White Xyqon Hoodie', category: 'Hooded sweater', priceUsd: this.hoodiePriceUsd, mockupClass: 'hoodie white' },
    { id: 'black-hoodie', name: 'Black Xyqon Hoodie', category: 'Hooded sweater', priceUsd: this.hoodiePriceUsd, mockupClass: 'hoodie black' },
    { id: 'blue-shirt', name: 'Light Blue Xyqon T-Shirt', category: 'T-shirt', priceUsd: this.tshirtPriceUsd, mockupClass: 'shirt sky' },
    { id: 'white-shirt', name: 'White Xyqon T-Shirt', category: 'T-shirt', priceUsd: this.tshirtPriceUsd, mockupClass: 'shirt white' },
    { id: 'black-shirt', name: 'Black Xyqon T-Shirt', category: 'T-shirt', priceUsd: this.tshirtPriceUsd, mockupClass: 'shirt black' }
  ];
  orderDrafts = signal<Record<string, ClothingOrderDraft>>({});

  onlineNodes = computed(() => this.dashboard()?.nodes.filter((node) => node.online).length ?? 0);
  matchedAddress = computed(() => {
    const value = this.query().trim();
    return value ? this.dashboard()?.publicAddresses.find((address) => address.address === value) ?? null : null;
  });
  matchedBlock = computed(() => {
    const value = this.query().trim();
    return value
      ? this.dashboard()?.recentBlocks.find((block) => `${block.index}` === value || block.hash === value) ?? null
      : null;
  });
  matchedTransaction = computed(() => {
    const value = this.query().trim();
    return value
      ? this.dashboard()?.recentTransactions.find((transaction) => transaction.id === value) ?? null
      : null;
  });

  constructor() {
    this.load();
    this.updateSeo(this.page());
    firebaseRuntime
      .then((firebase) => firebase.onAuthStateChanged(firebase.auth, (user) => this.user.set(user)))
      .catch((error) => this.communityMessage.set(this.authError(error)));
    window.addEventListener('popstate', () => this.page.set(this.routeFromPath()));
    window.addEventListener('popstate', () => {
      const page = this.routeFromPath();
      this.updateSeo(page);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  navigate(event: Event, page: Page) {
    event.preventDefault();
    const path = page === 'home' ? '/' : `/${page}`;
    history.pushState(null, '', path);
    this.page.set(page);
    this.updateSeo(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  translatePage(event: Event) {
    const select = event.target as HTMLSelectElement;
    const languageCode = select.value;
    if (!languageCode) {
      return;
    }

    const sourceUrl = new URL(seoByPage[this.page()].path, 'https://xyqon.web.app').toString();
    select.selectedIndex = 0;
    if (languageCode === 'en') {
      window.location.assign(sourceUrl);
      return;
    }

    const translateUrl = `https://translate.google.com/translate?sl=en&tl=${encodeURIComponent(languageCode)}&u=${encodeURIComponent(sourceUrl)}`;
    window.open(translateUrl, '_blank', 'noopener,noreferrer');
  }

  selectedSize(productId: string): ClothingSize {
    return this.orderDraft(productId).size;
  }

  selectSize(productId: string, size: ClothingSize) {
    this.patchOrderDraft(productId, { size });
  }

  orderDraft(productId: string): ClothingOrderDraft {
    return this.orderDrafts()[productId] ?? { size: 'M', transactionHash: '', deliveryAddress: '' };
  }

  updateOrderField(productId: string, field: 'transactionHash' | 'deliveryAddress', value: string) {
    this.patchOrderDraft(productId, { [field]: value });
  }

  async submitClothingOrder(event: Event, product: ClothingProduct) {
    event.preventDefault();
    const activeUser = this.user();
    if (!activeUser) {
      this.orderMessage.set('Please sign in with Google before submitting a clothing order.');
      return;
    }

    const draft = this.orderDraft(product.id);
    const transactionHash = draft.transactionHash.trim();
    const deliveryAddress = draft.deliveryAddress.trim();
    if (!transactionHash || !deliveryAddress) {
      this.orderMessage.set('Please add your transaction hash and delivery address before submitting.');
      return;
    }

    this.orderBusy.set(true);
    this.orderMessage.set(null);
    try {
      const firebase = await firebaseRuntime;
      const orderId = `${activeUser.uid}-${product.id}-${Date.now()}`;
      await firebase.setDoc(
        firebase.doc(firebase.db, 'xyqonClothingOrders', orderId),
        {
          orderId,
          uid: activeUser.uid,
          displayName: activeUser.displayName ?? '',
          email: activeUser.email ?? '',
          productId: product.id,
          productName: product.name,
          category: product.category,
          size: draft.size,
          itemPriceUsd: product.priceUsd,
          deliveryUsd: this.deliveryUsd,
          totalUsd: product.priceUsd + this.deliveryUsd,
          usdtAddress: this.usdtAddress,
          transactionHash,
          deliveryAddress,
          status: 'submitted',
          createdAt: firebase.serverTimestamp(),
          updatedAt: firebase.serverTimestamp()
        },
        { merge: false }
      );
      this.patchOrderDraft(product.id, { transactionHash: '', deliveryAddress: '' });
      this.orderMessage.set(`Your clothing order was submitted. Order ID: ${orderId}`);
    } catch (error) {
      this.orderMessage.set(this.authError(error));
    } finally {
      this.orderBusy.set(false);
    }
  }

  transactionType(transaction: ExplorerTransaction) {
    const operation = transaction.asset_operation;
    if (transaction.isCoinbase) {
      return 'Reward';
    }
    if (operation?.CreateCoin) {
      return 'Coin Create';
    }
    if (operation?.TransferCoin) {
      return 'Coin Send';
    }
    if (operation?.RegisterCollection) return 'Collection Register';
    if (operation?.UpdateCollection) return 'Collection Update';
    if (operation?.LockCollection) return 'Collection Lock';
    if (operation?.MintNft) {
      return 'NFT Mint';
    }
    if (operation?.TransferNft) {
      return 'NFT Send';
    }
    return 'Transfer';
  }

  transactionLabel(transaction: ExplorerTransaction) {
    const operation = transaction.asset_operation;
    if (operation?.CreateCoin) {
      return `${operation.CreateCoin.supply} ${operation.CreateCoin.symbol}`;
    }
    if (operation?.TransferCoin) {
      return `${operation.TransferCoin.amount} ${operation.TransferCoin.symbol}`;
    }
    if (operation?.RegisterCollection) return operation.RegisterCollection.collection;
    if (operation?.UpdateCollection) return operation.UpdateCollection.collection;
    if (operation?.LockCollection) return operation.LockCollection.collection;
    if (operation?.MintNft) {
      return `${operation.MintNft.collection}:${operation.MintNft.token_id}`;
    }
    if (operation?.TransferNft) {
      return `${operation.TransferNft.collection}:${operation.TransferNft.token_id}`;
    }
    return `${transaction.amount} XYQON`;
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<DashboardResponse>(dashboardApiEndpoint('dashboard')).subscribe({
      next: (dashboard) => {
        this.dashboard.set(dashboard);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(error?.message ?? 'Could not load dashboard data.');
        this.loading.set(false);
      }
    });
  }

  async joinWithGoogle() {
    this.authBusy.set(true);
    this.communityMessage.set(null);
    try {
      const firebase = await firebaseRuntime;
      const credential = await firebase.signInWithPopup(firebase.auth, new firebase.GoogleAuthProvider());
      await this.saveMember(credential.user);
      this.communityMessage.set('You are registered as a Xyqon community member.');
    } catch (error) {
      this.communityMessage.set(this.authError(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async registerMember() {
    const activeUser = this.user();
    if (!activeUser) {
      return;
    }
    this.authBusy.set(true);
    this.communityMessage.set(null);
    try {
      await this.saveMember(activeUser);
      this.communityMessage.set('Your community profile is up to date.');
    } catch (error) {
      this.communityMessage.set(this.authError(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async leave() {
    this.authBusy.set(true);
    this.communityMessage.set(null);
    try {
      const firebase = await firebaseRuntime;
      await firebase.signOut(firebase.auth);
      this.communityMessage.set('Signed out. The dashboard and explorer are still public.');
    } catch (error) {
      this.communityMessage.set(this.authError(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  private async saveMember(member: FirebaseUser) {
    const firebase = await firebaseRuntime;
    await firebase.setDoc(
      firebase.doc(firebase.db, 'xyqonCommunityMembers', member.uid),
      {
        label: 'xyqon community member',
        uid: member.uid,
        displayName: member.displayName ?? '',
        email: member.email ?? '',
        photoURL: member.photoURL ?? '',
        provider: 'google',
        status: 'active',
        contributionInterest: 'project community',
        updatedAt: firebase.serverTimestamp(),
        createdAt: firebase.serverTimestamp()
      },
      { merge: true }
    );
  }

  private authError(error: unknown) {
    return error instanceof Error ? error.message : 'Could not complete Google sign-in.';
  }

  private patchOrderDraft(productId: string, patch: Partial<ClothingOrderDraft>) {
    const current = this.orderDraft(productId);
    this.orderDrafts.update((drafts) => ({
      ...drafts,
      [productId]: { ...current, ...patch }
    }));
  }

  private updateSeo(page: Page) {
    const seo = seoByPage[page];
    const canonicalUrl = new URL(seo.path, 'https://xyqon.web.app').toString();
    const robots = seo.index
      ? 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'
      : 'noindex, follow';

    document.documentElement.lang = 'en';
    document.title = seo.title;
    this.setMeta('name', 'description', seo.description);
    this.setMeta('name', 'robots', robots);
    this.setMeta('name', 'googlebot', robots);
    this.setMeta('property', 'og:type', 'website');
    this.setMeta('property', 'og:locale', 'en_US');
    this.setMeta('property', 'og:title', seo.title);
    this.setMeta('property', 'og:description', seo.description);
    this.setMeta('property', 'og:url', canonicalUrl);
    this.setMeta('name', 'twitter:title', seo.title);
    this.setMeta('name', 'twitter:description', seo.description);

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = canonicalUrl;

    const schema = document.getElementById('xyqon-structured-data');
    if (schema) {
      schema.textContent = JSON.stringify(this.structuredData(page, seo, canonicalUrl));
    }
  }

  private setMeta(attribute: 'name' | 'property', key: string, content: string) {
    let meta = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute(attribute, key);
      document.head.appendChild(meta);
    }
    meta.content = content;
  }

  private structuredData(page: Page, seo: SeoConfig, canonicalUrl: string) {
    const graph: Record<string, unknown>[] = [
      {
        '@type': 'Organization',
        '@id': 'https://xyqon.web.app/#organization',
        name: 'XYQON',
        url: 'https://xyqon.web.app/',
        logo: 'https://xyqon.web.app/assets/xyqon-logo.png',
        sameAs: [
          'https://github.com/gideonlouw/xyqon',
          'https://www.npmjs.com/package/xyqon',
          'https://discord.gg/Pz8HfhxX2'
        ]
      },
      {
        '@type': 'WebSite',
        '@id': 'https://xyqon.web.app/#website',
        name: 'XYQON',
        url: 'https://xyqon.web.app/',
        inLanguage: 'en',
        publisher: { '@id': 'https://xyqon.web.app/#organization' }
      },
      {
        '@type': 'SoftwareApplication',
        '@id': 'https://xyqon.web.app/#software',
        name: 'XYQON',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, Windows, macOS',
        softwareVersion: '0.2.0',
        url: 'https://xyqon.web.app/',
        downloadUrl: 'https://github.com/gideonlouw/xyqon/releases/tag/v0.2.0',
        license: 'https://github.com/gideonlouw/xyqon/blob/main/LICENSE'
      },
      {
        '@type': 'WebPage',
        '@id': `${canonicalUrl}#webpage`,
        name: seo.title,
        description: seo.description,
        url: canonicalUrl,
        inLanguage: 'en',
        isPartOf: { '@id': 'https://xyqon.web.app/#website' },
        about: { '@id': 'https://xyqon.web.app/#software' }
      }
    ];

    if (page === 'run-a-node') {
      graph.push({
        '@type': 'HowTo',
        '@id': 'https://xyqon.web.app/run-a-node#howto',
        name: 'How to run a XYQON node on Linux',
        description: seo.description,
        totalTime: 'PT15M',
        supply: [
          { '@type': 'HowToSupply', name: 'Linux server with a stable public IPv4 address' },
          { '@type': 'HowToSupply', name: 'Official signed XYQON 0.2.0 binary' }
        ],
        step: [
          { '@type': 'HowToStep', position: 1, name: 'Install the verified binary', url: `${canonicalUrl}#install` },
          { '@type': 'HowToStep', position: 2, name: 'Prepare node storage', url: `${canonicalUrl}#storage` },
          { '@type': 'HowToStep', position: 3, name: 'Add trusted seed peers', url: `${canonicalUrl}#peers` },
          { '@type': 'HowToStep', position: 4, name: 'Open TCP port 7101', url: `${canonicalUrl}#firewall` },
          { '@type': 'HowToStep', position: 5, name: 'Start the relay node', url: `${canonicalUrl}#start` },
          { '@type': 'HowToStep', position: 6, name: 'Verify synchronization', url: `${canonicalUrl}#verify` }
        ]
      });
    }

    return { '@context': 'https://schema.org', '@graph': graph };
  }

  private routeFromPath() {
    const path = window.location.pathname.replace(/^\/+/, '').split('/')[0];
    if (path === 'run-a-node') {
      return path;
    }
    if (path === 'dashboard' || path === 'explorer' || path === 'community' || path === 'developers' || path === 'clothing') {
      return path;
    }
    return 'home';
  }
}

function dashboardApiEndpoint(path: string) {
  const normalizedPath = path.replace(/^\/+/, '');
  const normalizedBaseUrl = dashboardApiBaseUrl.replace(/\/+$/, '');
  if (normalizedBaseUrl) {
    return `${normalizedBaseUrl}/${normalizedPath}`;
  }
  return `/api/${normalizedPath}`;
}

async function loadFirebaseRuntime(): Promise<FirebaseRuntime> {
  const app = initializeApp(firebaseConfig);
  return {
    auth: getAuth(app),
    db: getFirestore(app),
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithPopup,
    signOut,
    doc,
    setDoc,
    serverTimestamp
  };
}

bootstrapApplication(App, {
  providers: [provideHttpClient()]
}).catch((error) => console.error(error));
