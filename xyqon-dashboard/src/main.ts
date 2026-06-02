import { Component, computed, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { DecimalPipe, DatePipe, NgClass } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';

type Transaction = {
  sender: string;
  recipient: string;
  amount: number;
  sender_public_key: string;
  signature: string;
  asset_operation?: {
    CreateCoin?: { symbol: string; name: string; supply: number };
    TransferCoin?: { symbol: string; amount: number };
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
  nfts: NftAsset[];
  recentBlocks: Block[];
  recentTransactions: ExplorerTransaction[];
};

@Component({
  selector: 'app-root',
  imports: [DecimalPipe, DatePipe, NgClass],
  template: `
    <main class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">XYQON Network</p>
          <h1>Live Node Dashboard</h1>
        </div>
        <button type="button" class="refresh" (click)="load()" [disabled]="loading()">
          {{ loading() ? 'Refreshing' : 'Refresh' }}
        </button>
      </header>

      @if (error()) {
        <section class="notice">{{ error() }}</section>
      }

      @if (dashboard(); as data) {
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
      } @else {
        <section class="loading">Loading network data...</section>
      }
    </main>
  `
})
class App {
  private http = inject(HttpClient);
  dashboard = signal<DashboardResponse | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  query = signal('');
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
    if (operation?.MintNft) {
      return `${operation.MintNft.collection}:${operation.MintNft.token_id}`;
    }
    if (operation?.TransferNft) {
      return `${operation.TransferNft.collection}:${operation.TransferNft.token_id}`;
    }
    return `${transaction.amount} XYQON`;
  }

  constructor() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<DashboardResponse>('/api/dashboard').subscribe({
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
}

bootstrapApplication(App, {
  providers: [provideHttpClient()]
}).catch((error) => console.error(error));
