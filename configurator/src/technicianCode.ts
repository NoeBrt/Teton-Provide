// What a technician code says about itself (name, customers, expiry: not secret) and why it may not be usable; shared
// by the technician sheet's code card and its checks. Pure, so it is tested without React Native.
import { checkToken, parseTokenText, TECHNICIAN_AUTHORITY, type Token } from './authority.ts';

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const expiryText = (expires: number) =>
  new Date(expires * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const validity = (expires: number, now = nowSeconds()) => `${expires <= now ? 'expired on' : 'valid until'} ${expiryText(expires)}`;

/** Why a scanned or pasted code cannot be used, or null if it can. */
export function tokenProblem(token: Token | null, now = nowSeconds(), authority = TECHNICIAN_AUTHORITY): string | null {
  if (!token) return 'This is not a technician code. Scan the code IoT sent you, or paste it.';
  const check = checkToken(token, now, authority);
  if (check === 'invalid') return 'This code was not issued by IoT.';
  if (check === 'expired') return `This code expired on ${expiryText(token.expires)}. Ask IoT for a new one.`;
  return null;
}

/** The pasted code card: what to show, never the code itself (about 300 characters: the signature and the holder's key). */
export type PastedCode =
  | { kind: 'empty' }
  | { kind: 'ok'; name: string; line: string; length: number }
  | { kind: 'problem'; message: string; length: number };

export function pastedCode(text: string, now = nowSeconds(), authority = TECHNICIAN_AUTHORITY): PastedCode {
  const code = text.trim();
  if (!code) return { kind: 'empty' };
  const token = parseTokenText(code);
  const problem = tokenProblem(token, now, authority);
  if (problem || !token) return { kind: 'problem', message: problem ?? '', length: code.length };
  return { kind: 'ok', name: token.name, line: `${token.customers.join(', ')} · ${validity(token.expires, now)}`, length: code.length };
}
