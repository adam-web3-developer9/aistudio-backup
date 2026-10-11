import type { BrowserAdapter, AdapterInput } from './adapter.js';
import type { Page } from 'playwright';

export class DemoAdapter implements BrowserAdapter {
  readonly id = 'demo-v1';
  readonly allowedCookieDomains = ['127.0.0.1', 'localhost'];

  constructor(private readonly baseUrl: string) {}

  async run(page: Page, input: AdapterInput): Promise<unknown> {
    await page.goto(`${this.baseUrl}/internal/demo-page`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('文字内容').fill(input.text);
    await page.getByLabel('上传图片').setInputFiles(input.imagePath);
    await page.getByRole('button', { name: '提交查询' }).click();

    const result = page.locator('#result[data-ready="true"]');
    await result.waitFor({ state: 'visible' });

    return result.evaluate((element) => ({
      message: element.textContent,
      text: element.getAttribute('data-text'),
      fileName: element.getAttribute('data-file-name')
    }));
  }
}
