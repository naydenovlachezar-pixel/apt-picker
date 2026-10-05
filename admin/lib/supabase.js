import { createClient } from "@supabase/supabase-js";

// Публичните стойности на проекта. Може да се сменят с променливи на средата във Vercel.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zmpcsksagrxtrdyqjnvw.supabase.co";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_k7D6pANGMnHAa652DTQBgQ_sAZAgAbE";

export const WIDGET_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_ORIGIN || "https://apt-picker-engine.vercel.app";

let client;
export function supabase() {
  if (!client) client = createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  return client;
}
