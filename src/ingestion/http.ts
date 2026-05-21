import { logger } from './logger.js';

const USER_AGENT = 'SleevedPages/1.0.0';
const MIN_INTERVAL_MS = 100;
const MAX_RETRIES = 3;
const BACKOFF_MS = [100, 400, 1600];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimitedClient {
  private lastRequestAt = 0;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get<T>(path: string): Promise<T> {
    await this.throttle();
    return this.fetchWithRetry<T>(this.baseUrl + path, 0);
  }

  async getText(path: string): Promise<string> {
    await this.throttle();
    return this.fetchTextWithRetry(this.baseUrl + path, 0);
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  private async fetchWithRetry<T>(url: string, attempt: number): Promise<T> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 1600;
        logger.warn('Request failed, retrying', {
          url,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await sleep(delay);
        await this.throttle();
        return this.fetchWithRetry<T>(url, attempt + 1);
      }
      throw err;
    }
  }

  private async fetchTextWithRetry(url: string, attempt: number): Promise<string> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      }
      return res.text();
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 1600;
        logger.warn('Request failed, retrying', {
          url,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await sleep(delay);
        await this.throttle();
        return this.fetchTextWithRetry(url, attempt + 1);
      }
      throw err;
    }
  }
}
