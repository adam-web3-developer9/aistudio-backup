import type { Browser } from 'playwright';

interface BrowserSlot {
  id: number;
  browser: Browser;
  busy: boolean;
  completedJobs: number;
}

export class BrowserPool {
  private readonly slots: BrowserSlot[] = [];
  private readonly waiters: Array<(slot: BrowserSlot) => void> = [];
  private launchError: Error | undefined;

  constructor(
    readonly size: number,
    private readonly headless: boolean,
    private readonly proxyUrl?: string
  ) {}

  /**
   * Best-effort warm-up. Adapters that talk to the API directly never need a
   * browser, so a missing Playwright install must not stop the service from
   * booting — the failure is re-raised from `use()` if a job actually needs one.
   */
  async initialize(): Promise<void> {
    try {
      for (let index = 0; index < this.size; index += 1) {
        this.slots.push(await this.launchSlot(index + 1));
      }
      this.launchError = undefined;
    } catch (error) {
      this.launchError = error instanceof Error ? error : new Error(String(error));
    }
  }

  get available(): boolean {
    return this.slots.length > 0;
  }

  get error(): Error | undefined {
    return this.launchError;
  }

  async use<T>(run: (browser: Browser, slotId: number) => Promise<T>): Promise<T> {
    if (!this.slots.length) {
      // Nothing warmed up: retry once so a late Playwright install still works.
      await this.initialize();
      if (!this.slots.length) {
        throw new Error(
          `No browser available (run "pnpm browser:install"): ${this.launchError?.message ?? 'unknown error'}`
        );
      }
    }
    const slot = await this.acquire();
    try {
      if (!slot.browser.isConnected()) {
        slot.browser = (await this.launchSlot(slot.id)).browser;
      }
      const result = await run(slot.browser, slot.id);
      slot.completedJobs += 1;
      return result;
    } finally {
      this.release(slot);
    }
  }

  stats(): {
    size: number;
    busy: number;
    waiting: number;
    completedJobs: number;
    available: boolean;
    error?: string;
  } {
    return {
      size: this.slots.length,
      busy: this.slots.filter((slot) => slot.busy).length,
      waiting: this.waiters.length,
      completedJobs: this.slots.reduce((sum, slot) => sum + slot.completedJobs, 0),
      available: this.available,
      error: this.launchError?.message
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.slots.map((slot) => slot.browser.close()));
  }

  private async launchSlot(id: number): Promise<BrowserSlot> {
    const { chromium } = await import('playwright');
    const proxyUrl = this.proxyUrl ? new URL(this.proxyUrl) : undefined;
    const browser = await chromium.launch({
      headless: this.headless,
      proxy: proxyUrl ? {
        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
        username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
        password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        bypass: 'localhost,127.0.0.1'
      } : undefined
    });
    return { id, browser, busy: false, completedJobs: 0 };
  }

  private acquire(): Promise<BrowserSlot> {
    const available = this.slots.find((slot) => !slot.busy);
    if (available) {
      available.busy = true;
      return Promise.resolve(available);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(slot: BrowserSlot): void {
    const next = this.waiters.shift();
    if (next) {
      slot.busy = true;
      next(slot);
      return;
    }
    slot.busy = false;
  }
}
