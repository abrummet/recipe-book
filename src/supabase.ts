import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './config';

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Only created when the key is filled in; App shows a setup message otherwise.
export const supabase: SupabaseClient = configured
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : (null as unknown as SupabaseClient);

export const PHOTO_BUCKET = 'recipe-photos';
