import { login } from '../actions';
import { BrandSplash } from '../brand/logo';
import { ErrorBanner, first } from '../ui';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  return (
    <BrandSplash title="Owner access">
      <p className="meta">Local and single-owner. Enter XYP_WEB_TOKEN.</p>
      <ErrorBanner error={searchParams.error} />
      <form action={login} className="flex w-full max-w-md flex-col gap-3 text-left">
        <input type="hidden" name="next" value={first(searchParams.next) ?? '/vault'} />
        <label className="field">Token<input type="password" name="token" autoFocus required minLength={16} autoComplete="current-password" /></label>
        <button type="submit">Enter</button>
      </form>
    </BrandSplash>
  );
}
