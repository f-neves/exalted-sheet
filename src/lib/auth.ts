// Thin wrapper over Supabase Auth so pages never touch the client directly for
// sign-in concerns, and so error strings can be made readable in one place.
import type { User } from '@supabase/supabase-js';
import { getSupabase, supabaseConfigured } from './supabase';

export { supabaseConfigured };

/** Supabase returns terse English strings; these are the ones users actually hit. */
function readable(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return 'Wrong email or password.';
  if (m.includes('email not confirmed')) return 'Confirm your email first — check the link we sent.';
  if (m.includes('user already registered')) return 'That email already has an account. Sign in instead.';
  if (m.includes('password should be')) return 'Password is too short (at least 6 characters).';
  if (m.includes('unable to validate email')) return 'That does not look like a valid email.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  return message;
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  if (!supabaseConfigured) return { error: 'Supabase is not configured.' };
  const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
  return error ? { error: readable(error.message) } : {};
}

export async function signUp(email: string, password: string, name: string): Promise<{ error?: string }> {
  if (!supabaseConfigured) return { error: 'Supabase is not configured.' };
  // The name rides along in user metadata; the handle_new_user trigger turns it
  // into the profiles row, so there is no second write to race with.
  const { error } = await getSupabase().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { name: name.trim() } },
  });
  return error ? { error: readable(error.message) } : {};
}

export async function resetPassword(email: string, redirectTo?: string): Promise<{ error?: string }> {
  if (!supabaseConfigured) return { error: 'Supabase is not configured.' };
  const { error } = await getSupabase().auth.resetPasswordForEmail(
    email.trim(), redirectTo ? { redirectTo } : undefined);
  return error ? { error: readable(error.message) } : {};
}

export async function signOut(): Promise<void> {
  if (!supabaseConfigured) return;
  await getSupabase().auth.signOut();
}

export async function currentUser(): Promise<User | null> {
  if (!supabaseConfigured) return null;
  const { data } = await getSupabase().auth.getUser();
  return data?.user ?? null;
}

export async function profileName(): Promise<string> {
  const user = await currentUser();
  if (!user) return '';
  const { data } = await getSupabase().from('profiles').select('name').eq('id', user.id).maybeSingle();
  return (data?.name as string) || user.email?.split('@')[0] || '';
}

/**
 * Returns the signed-in user, or sends the browser to /login and returns null.
 * Callers should `return` immediately on null.
 */
export async function requireLogin(base: string): Promise<User | null> {
  const user = await currentUser();
  if (user) return user;
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `${base}login?next=${next}`;
  return null;
}
