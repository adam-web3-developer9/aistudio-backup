import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HailuoAdapter } from './hailuo-adapter.js';

afterEach(() => vi.restoreAllMocks());

describe('HailuoAdapter', () => {
  it('queries credits directly with the browser session token and signed request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_777_777_777_777);
    const get = vi.fn().mockResolvedValue({
      ok: vi.fn().mockReturnValue(true),
      json: vi.fn().mockResolvedValue({ data: { totalCredits: 192 } })
    });
    const context = {
      cookies: vi.fn().mockResolvedValue([{ name: '_token', value: 'login-token' }]),
      request: { get }
    };
    const page = { context: vi.fn().mockReturnValue(context) } as unknown as Page;

    const balance = await new HailuoAdapter(
      'https://hailuoai.com/create/image-to-video'
    ).getCredits(page);

    expect(balance).toEqual({ totalCredits: 192, breakdown: [] });
    expect(get).toHaveBeenCalledOnce();
    const [url, options] = get.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://hailuoai.com/v1/api/user/equity?');
    expect(url).toContain('app_id=3001');
    expect(url).toContain('version_code=22203');
    expect(url).toContain('unix=1777777777777');
    expect(options.headers.token).toBe('login-token');
    expect(options.headers.yy).toMatch(/^[a-f0-9]{32}$/);
  });

  it('uploads the reference, fills the Slate editor and starts creation', async () => {
    const uploadInput = locator({ setInputFiles: vi.fn().mockResolvedValue(undefined) });
    const uploadWrapper = locator({ locator: vi.fn().mockReturnValue(uploadInput) });
    const uploadButton = locator({
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(uploadWrapper)
    });
    const promptEditor = locator({
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined)
    });
    const createButton = locator({
      waitFor: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined)
    });
    const creditResponse = {
      ok: vi.fn().mockReturnValue(true),
      status: vi.fn().mockReturnValue(200),
      json: vi.fn().mockResolvedValue({
        statusInfo: { code: 0 },
        data: { totalCredits: 192 }
      })
    };

    const page = {
      goto: vi.fn().mockResolvedValue(null),
      waitForResponse: vi.fn().mockResolvedValue(creditResponse),
      getByRole: vi.fn()
        .mockReturnValueOnce(uploadButton)
        .mockReturnValueOnce(createButton),
      locator: vi.fn().mockReturnValue(promptEditor),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://hailuoai.com/create/image-to-video')
    } as unknown as Page;

    const result = await new HailuoAdapter('https://hailuoai.com/create/image-to-video').run(page, {
      text: '让人物转身看向镜头',
      imagePath: 'D:\\uploads\\reference.png'
    });

    expect(page.goto).toHaveBeenCalledWith('https://hailuoai.com/create/image-to-video', {
      waitUntil: 'domcontentloaded'
    });
    expect(uploadInput.setInputFiles).toHaveBeenCalledWith('D:\\uploads\\reference.png');
    expect(promptEditor.fill).toHaveBeenCalledWith('让人物转身看向镜头');
    expect(createButton.click).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 'submitted',
      text: '让人物转身看向镜头',
      currentCredits: 192,
      creditBalance: { totalCredits: 192, breakdown: [] },
      pageUrl: 'https://hailuoai.com/create/image-to-video'
    });
  });
});

function locator<T extends Record<string, unknown>>(overrides: T): T & { first: ReturnType<typeof vi.fn> } {
  const value = {
    first: vi.fn(),
    ...overrides
  } as T & { first: ReturnType<typeof vi.fn> };
  value.first.mockReturnValue(value);
  return value;
}
