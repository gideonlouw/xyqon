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

type AddressBalance = {
  address: string;
  balance: number;
  mined: number;
  received: number;
  sent: number;
  transactions: number;
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
  recentBlocks: Block[];
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
  onlineNodes = computed(() => this.dashboard()?.nodes.filter((node) => node.online).length ?? 0);

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
