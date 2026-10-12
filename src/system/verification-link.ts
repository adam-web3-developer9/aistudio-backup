/** Keep default verification callbacks on the account result page, including old emails. */
export function normalizeVerificationCallback(url: URL, baseUrl: string): void {
  if (url.pathname !== '/api/auth/verify-email') return;
  const callback = url.searchParams.get('callbackURL');
  if (callback && callback !== '/' && callback !== baseUrl && callback !== `${baseUrl}/`) return;
  url.searchParams.set('callbackURL', new URL('/account/verified', baseUrl).href);
}
