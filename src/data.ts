// Loads one book's contents from the shared database and keeps them fresh.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PHOTO_BUCKET, supabase } from './supabase';
import type { Ing, Step } from './format';

export type Recipe = {
  id: string; book_id: string; name: string; servings: number | null; total_minutes: number | null;
  ingredients: Ing[]; steps: Step[]; notes: string; source_type: string; source_url: string | null;
  photo_path: string | null; source_photo_paths: string[]; added_by: string | null; created_at: string;
};
export type Book = { id: string; name: string; owner_id: string; yearly_pdf_enabled: boolean; use_metric: boolean };
export type Tag = { id: string; name: string };
export type Mark = { recipe_id: string; user_id: string; favorite: boolean; rating: number | null };
export type CookLog = { id: string; recipe_id: string; user_id: string; cooked_on: string; scale: number; rating: number | null; note: string };
export type ShoppingItem = { id: string; text: string; recipe_id: string | null; done: boolean; added_by: string | null };
export type PlanEntry = { id: string; plan_date: string; recipe_id: string };
export type Member = { user_id: string; role: string; name: string };

export type BookData = {
  book: Book; recipes: Recipe[]; tags: Tag[]; recipeTags: { recipe_id: string; tag_id: string }[];
  marks: Mark[]; logs: CookLog[]; shopping: ShoppingItem[]; plan: PlanEntry[]; members: Member[];
};

async function fetchBook(bookId: string): Promise<BookData> {
  const [book, recipes, tags, shopping, plan, members] = await Promise.all([
    supabase.from('books').select('*').eq('id', bookId).single(),
    supabase.from('recipes').select('*').eq('book_id', bookId).order('name'),
    supabase.from('tags').select('id,name').eq('book_id', bookId).order('name'),
    supabase.from('shopping_items').select('*').eq('book_id', bookId).order('created_at'),
    supabase.from('meal_plan').select('id,plan_date,recipe_id').eq('book_id', bookId),
    supabase.from('book_members').select('user_id,role').eq('book_id', bookId),
  ]);
  const firstError = [book, recipes, tags, shopping, plan, members].find((r) => r.error)?.error;
  if (firstError) throw new Error(firstError.message);

  const ids = (recipes.data || []).map((r) => r.id);
  const memberIds = (members.data || []).map((m) => m.user_id);
  const none = { data: [] as any[], error: null };
  const [recipeTags, marks, logs, profiles] = await Promise.all([
    ids.length ? supabase.from('recipe_tags').select('recipe_id,tag_id').in('recipe_id', ids) : none,
    ids.length ? supabase.from('recipe_marks').select('*').in('recipe_id', ids) : none,
    ids.length ? supabase.from('cook_logs').select('*').in('recipe_id', ids).order('created_at', { ascending: false }) : none,
    memberIds.length ? supabase.from('profiles').select('id,display_name').in('id', memberIds) : none,
  ]);
  const secondError = [recipeTags, marks, logs, profiles].find((r) => r.error)?.error;
  if (secondError) throw new Error(secondError.message);

  const nameOf = new Map((profiles.data || []).map((p: any) => [p.id, p.display_name]));
  return {
    book: book.data as Book,
    recipes: (recipes.data || []) as Recipe[],
    tags: (tags.data || []) as Tag[],
    recipeTags: recipeTags.data || [],
    marks: (marks.data || []) as Mark[],
    logs: (logs.data || []) as CookLog[],
    shopping: (shopping.data || []) as ShoppingItem[],
    plan: (plan.data || []) as PlanEntry[],
    members: (members.data || []).map((m) => ({ ...m, name: nameOf.get(m.user_id) || 'Member' })),
  };
}

export function useBook(bookId: string) {
  const [data, setData] = useState<BookData | null>(null);
  const [error, setError] = useState('');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const signed = useRef<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const d = await fetchBook(bookId);
      setData(d);
      setError('');
      // Photos are private, so each needs a temporary viewing link.
      const need = d.recipes.flatMap((r) => [r.photo_path, ...(r.source_photo_paths || [])]).filter((p): p is string => !!p && !signed.current[p]);
      if (need.length) {
        const res = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(need, 60 * 60 * 6);
        for (const row of res.data || []) if (row.path && row.signedUrl) signed.current[row.path] = row.signedUrl;
        setUrls({ ...signed.current });
      }
    } catch (e: any) {
      setError(e.message || 'Could not load the book');
    }
  }, [bookId]);

  useEffect(() => {
    setData(null);
    reload();
    // When the other person changes something, reload shortly after.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { clearTimeout(timer); timer = setTimeout(reload, 300); };
    const channel = supabase.channel('book-' + bookId).on('postgres_changes', { event: '*', schema: 'public' }, soon).subscribe();
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bookId, reload]);

  return { data, error, urls, reload };
}

/** Shrinks a photo before upload so it loads quickly and uses little storage. */
export async function shrinkPhoto(file: File, max = 1400): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo'))), 'image/jpeg', 0.82)
  );
}
