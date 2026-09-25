import { login } from '../actions';
import { ErrorBanner, first } from '../ui';

export const dynamic = 'force-dynamic';

export default function Login({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  return (
    <section className="max-w-md">
      <h1>Owner access</h1>
      <p className="meta my-4">Local and single-owner. Enter XYP_WEB_TOKEN.</p>
      <ErrorBanner error={searchParams.error} />
      <form action={login} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={first(searchParams.next) ?? '/vault'} />
        <label className="field">Token<input type="password" name="token" autoFocus required minLength={16} autoComplete="current-password" /></label>
        <button type="submit">Enter</button>
      </form>
    </section>
  );
}
