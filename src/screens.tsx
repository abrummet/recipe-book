import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Ctx } from './App';
import { shrinkPhoto, type Recipe } from './data';
import { addDays, fmtAmt, fmtQty, ingredientsToText, isoDate, lines, parseIngredient, parseStep } from './format';
import { PHOTO_BUCKET, supabase } from './supabase';
import { readLink, readPdf, readPhotos, textToDraft, type Draft } from './importers';

// ---------------------------------------------------------------- small pieces

export const I = {
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z M8 7h7',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  plus: 'M12 5v14 M5 12h14',
  list: 'M5 6h14 M5 12h14 M5 18h9',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
  back: 'M15 5l-7 7 7 7',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  pencil: 'M4 20l1-4L16 5l3 3L8 19z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  check: 'M5 12l5 5 9-10',
  star: 'M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z',
  dish: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  x: 'M6 6l12 12 M18 6L6 18',
};

export function Icon({ d, size = 22, fill = 'none', stroke }: { d: string; size?: number; fill?: string; stroke?: number }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size, fill, strokeWidth: stroke }}>
      <path d={d} />
    </svg>
  );
}

const TILES = [['#FFE1B8', '#8A4B00'], ['#CFEBD2', '#1F5E2A'], ['#FBD3CD', '#8C2A1C'], ['#CFE2F8', '#1D4C80'], ['#F6E9AE', '#6B5600'], ['#E1D6F4', '#4A2F85']];
function tileOf(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length];
}

function Photo({ ctx, r, height, radius = 0 }: { ctx: Ctx; r: Recipe; height: number; radius?: number }) {
  const url = r.photo_path ? ctx.urls[r.photo_path] : '';
  const [bg, fg] = tileOf(r.id);
  if (url) return <img src={url} alt="" style={{ width: '100%', height, objectFit: 'cover', borderRadius: radius, display: 'block' }} />;
  return (
    <div className="tile" style={{ height, borderRadius: radius, background: bg, color: fg }}>
      <Icon d={I.dish} size={height > 150 ? 44 : 30} />
    </div>
  );
}

function Check({ on }: { on: boolean }) {
  return <span className={'box' + (on ? ' on' : '')}>{on && <Icon d={I.check} size={16} stroke={3} />}</span>;
}

function Stars({ value, onSet, label }: { value: number; onSet: (n: number) => void; label: string }) {
  return (
    <div className="row" style={{ gap: 0 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} aria-label={`${label}: ${n} of 5`} onClick={() => onSet(n === value ? 0 : n)}
          style={{ width: 40, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#B26A00' }}>
          <Icon d={I.star} fill={n <= value ? '#B26A00' : 'none'} />
        </button>
      ))}
    </div>
  );
}

function TopBar({ title, sub, onBack, right }: { title: string; sub?: string; onBack: () => void; right?: ReactNode }) {
  return (
    <div className="row">
      <button className="iconbtn" aria-label="Back" onClick={onBack}><Icon d={I.back} /></button>
      <div className="grow">
        {sub && <div className="muted">{sub}</div>}
        <div className="h2">{title}</div>
      </div>
      {right}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="stack">
      <span style={{ fontWeight: 600 }}>{label}{hint && <span className="muted"> · {hint}</span>}</span>
      {children}
    </label>
  );
}

const tagIdsOf = (ctx: Ctx, recipeId: string) => ctx.d.recipeTags.filter((x) => x.recipe_id === recipeId).map((x) => x.tag_id);
const myMark = (ctx: Ctx, recipeId: string) => ctx.d.marks.find((m) => m.recipe_id === recipeId && m.user_id === ctx.userId);
const setMark = (ctx: Ctx, recipeId: string, patch: { favorite?: boolean; rating?: number | null }) =>
  ctx.act(supabase.from('recipe_marks').upsert({ recipe_id: recipeId, user_id: ctx.userId, ...patch }, { onConflict: 'recipe_id,user_id' }));

function addIngredientsToList(ctx: Ctx, r: Recipe, scale: number, metric: boolean) {
  if (!r.ingredients.length) { ctx.toast('This recipe has no ingredients yet'); return; }
  const rows = r.ingredients.map((i) => ({
    book_id: ctx.d.book.id, recipe_id: r.id, text: (fmtAmt(i, scale, metric) + ' ' + i.name).trim(),
  }));
  ctx.act(supabase.from('shopping_items').insert(rows), `${rows.length} ingredients added to the shopping list`);
}

// ---------------------------------------------------------------- sign in

export function Auth() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setMessage('');
    if (mode === 'up') {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password,
        options: { data: { display_name: name.trim() }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) setError(error.message);
      else if (!data.session) { setMessage('Check your email for a confirmation link. After you tap it, come back here and sign in.'); setMode('in'); }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError(error.message);
    }
    setBusy(false);
  }

  return (
    <form className="center" onSubmit={submit}>
      <div>
        <h1 className="h1">Recipe Book</h1>
        <div className="muted">{mode === 'in' ? 'Sign in to open your shared book.' : 'Create your own account. Each person has their own.'}</div>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}
      {mode === 'up' && (
        <Field label="Your first name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" required /></Field>
      )}
      <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
      <Field label="Password" hint={mode === 'up' ? 'at least 8 characters' : undefined}>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'up' ? 8 : undefined}
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required />
      </Field>
      <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
      <button type="button" className="linkbtn" style={{ textAlign: 'center' }} onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
        {mode === 'in' ? 'New here? Create an account' : 'Already have an account? Sign in'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- create or join a book

export function BookGate({ onDone, onCancel }: { onDone: (bookId: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(fn: 'create_book' | 'join_book', args: Record<string, string>) {
    setBusy(true); setError('');
    const { data, error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) setError(error.message);
    else onDone(data as string);
  }

  return (
    <div className="scroll"><div className="pad">
      <div>
        <h1 className="h1">Your recipe book</h1>
        <div className="muted">Start a new book, or join one someone has shared with you.</div>
      </div>
      {error && <div className="error">{error}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); run('create_book', { p_name: name }); }}>
        <h2 className="h2">Start a new book</h2>
        <Field label="Book name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Our Kitchen" required /></Field>
        <button className="btn primary" disabled={busy || !name.trim()}>Create book</button>
      </form>
      <form className="card" onSubmit={(e) => { e.preventDefault(); run('join_book', { p_code: code }); }}>
        <h2 className="h2">Join with a code</h2>
        <Field label="Invite code"><input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoCorrect="off" required /></Field>
        <button className="btn dark" disabled={busy || !code.trim()}>Join book</button>
      </form>
      {onCancel ? <button className="btn" onClick={onCancel}>Cancel</button>
        : <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>}
    </div></div>
  );
}

// ---------------------------------------------------------------- recipes list

const homeMemory = { q: '', tag: '', fav: false };

export function Home({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const [q, setQ] = useState(homeMemory.q);
  const [tag, setTag] = useState(homeMemory.tag);
  const [fav, setFav] = useState(homeMemory.fav);
  useEffect(() => { Object.assign(homeMemory, { q, tag, fav }); }, [q, tag, fav]);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const tagName = new Map(d.tags.map((t) => [t.id, t.name]));
    return d.recipes.filter((r) => {
      if (fav && !myMark(ctx, r.id)?.favorite) return false;
      const tagIds = tagIdsOf(ctx, r.id);
      if (tag && !tagIds.includes(tag)) return false;
      if (!words.length) return true;
      const hay = [r.name, r.notes, ...r.ingredients.map((i) => i.name), ...r.steps.map((s) => s.text), ...tagIds.map((t) => tagName.get(t) || '')]
        .join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [d, q, tag, fav, ctx.userId]);

  return (
    <div className="scroll"><div className="pad">
      <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div className="muted">Shared recipe book · {d.members.length} {d.members.length === 1 ? 'member' : 'members'}</div>
          <h1 className="h1">{d.book.name}</h1>
        </div>
        <div className="muted" style={{ whiteSpace: 'nowrap' }}>{list.length} {list.length === 1 ? 'recipe' : 'recipes'}</div>
      </div>
      <input type="search" aria-label="Search recipes" placeholder="Search names, ingredients, notes" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips-scroll">
        <button className={'chip' + (fav ? ' on' : '')} onClick={() => setFav(!fav)}>Favorites</button>
        {d.tags.map((t) => (
          <button key={t.id} className={'chip' + (tag === t.id ? ' on' : '')} onClick={() => setTag(tag === t.id ? '' : t.id)}>{t.name}</button>
        ))}
      </div>

      {d.recipes.length === 0 ? (
        <div className="card" style={{ alignItems: 'center', textAlign: 'center', padding: '28px 16px' }}>
          <div className="h2">No recipes yet</div>
          <div className="muted">Add your first one to get the book started.</div>
          <button className="btn primary" onClick={() => ctx.go({ s: 'edit' })}>Add a recipe</button>
        </div>
      ) : list.length === 0 ? (
        <div className="card" style={{ alignItems: 'center', textAlign: 'center', padding: '28px 16px' }}>
          <div className="h2">No recipes match</div>
          <div className="muted">Try a different word, or clear the tag filter.</div>
        </div>
      ) : (
        <div className="grid2">
          {list.map((r) => {
            const isFav = !!myMark(ctx, r.id)?.favorite;
            return (
              <div key={r.id} style={{ position: 'relative' }}>
                <button onClick={() => ctx.go({ s: 'detail', id: r.id })} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Photo ctx={ctx} r={r} height={130} radius={16} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.25 }}>{r.name}</div>
                    <div className="muted">{[r.total_minutes ? r.total_minutes + ' min' : '', ctx.nameOf(r.added_by)].filter(Boolean).join(' · ')}</div>
                  </div>
                </button>
                <button className="iconbtn white" aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  onClick={() => setMark(ctx, r.id, { favorite: !isFav })}
                  style={{ position: 'absolute', top: 4, right: 4, width: 36, height: 36, color: isFav ? '#D4351C' : undefined }}>
                  <Icon d={I.heart} size={18} fill={isFav ? '#D4351C' : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div></div>
  );
}

// ---------------------------------------------------------------- one recipe

export function Detail({ ctx, r }: { ctx: Ctx; r: Recipe }) {
  const { d } = ctx;
  const mark = myMark(ctx, r.id);
  const isFav = !!mark?.favorite;
  const [notes, setNotes] = useState(r.notes);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { setNotes(r.notes); }, [r.notes]);

  const tags = tagIdsOf(ctx, r.id).map((id) => d.tags.find((t) => t.id === id)).filter(Boolean);
  const logs = d.logs.filter((l) => l.recipe_id === r.id);
  const others = d.marks.filter((m) => m.recipe_id === r.id && m.user_id !== ctx.userId && m.rating);
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));

  async function uploadPhoto(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const blob = await shrinkPhoto(file);
      const path = `${d.book.id}/${r.id}/dish-${Date.now()}.jpg`;
      const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      await ctx.act(supabase.from('recipes').update({ photo_path: path }).eq('id', r.id), 'Photo saved');
    } catch (e: any) {
      ctx.toast(e.message || 'Could not save that photo');
    }
    setUploading(false);
  }

  function togglePlan(date: string) {
    const existing = d.plan.find((p) => p.plan_date === date && p.recipe_id === r.id);
    ctx.act(existing
      ? supabase.from('meal_plan').delete().eq('id', existing.id)
      : supabase.from('meal_plan').insert({ book_id: d.book.id, plan_date: date, recipe_id: r.id }));
  }

  return (
    <div className="scroll">
      <div className="hero">
        <Photo ctx={ctx} r={r} height={240} />
        <button className="iconbtn white" aria-label="Back to recipes" onClick={() => ctx.go({ s: 'home' })} style={{ left: 12 }}><Icon d={I.back} /></button>
        <button className="iconbtn white" aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => setMark(ctx, r.id, { favorite: !isFav })} style={{ right: 12, color: isFav ? '#D4351C' : undefined }}>
          <Icon d={I.heart} fill={isFav ? '#D4351C' : 'none'} />
        </button>
        <label className="iconbtn white" aria-label="Add or change the dish photo" style={{ position: 'absolute', right: 12, bottom: 12, cursor: 'pointer' }}>
          <Icon d={I.camera} />
          <input type="file" accept="image/*" hidden disabled={uploading} onChange={(e) => { uploadPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <div className="pad flush">
        {uploading && <div className="notice">Saving photo…</div>}
        <div className="stack" style={{ gap: 8 }}>
          <h1 className="h1">{r.name}</h1>
          <div className="muted">
            {[r.total_minutes ? r.total_minutes + ' min' : '', r.servings ? 'Serves ' + fmtQty(r.servings) : '', 'Added by ' + ctx.nameOf(r.added_by).replace('You', 'you')].filter(Boolean).join(' · ')}
          </div>
          {tags.length > 0 && (
            <div className="wrap" style={{ gap: 6 }}>
              {tags.map((t) => <span key={t!.id} style={{ background: 'var(--soft)', borderRadius: 12, padding: '4px 10px', fontSize: 13, fontWeight: 500 }}>{t!.name}</span>)}
            </div>
          )}
          <div className="row">
            <Stars value={mark?.rating || 0} label="Your rating" onSet={(n) => setMark(ctx, r.id, { rating: n || null })} />
            <span className="muted">{others.length ? others.map((m) => `${ctx.nameOf(m.user_id)} rated ${m.rating}`).join(' · ') : 'Your rating'}</span>
          </div>
        </div>

        <button className="btn primary" onClick={() => ctx.go({ s: 'make', id: r.id })}>Make this recipe</button>
        <div className="row">
          <button className="btn" onClick={() => addIngredientsToList(ctx, r, 1, d.book.use_metric)}>Add to shopping list</button>
          <button className="btn small" onClick={() => ctx.go({ s: 'edit', id: r.id })}><Icon d={I.pencil} size={18} />Edit</button>
        </div>

        <div className="card">
          <h2 className="h2">Ingredients</h2>
          <div className="divided">
            {r.ingredients.map((i, n) => (
              <div key={n} className="row" style={{ gap: 10, padding: '6px 0', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, minWidth: 72 }}>{fmtAmt(i, 1, d.book.use_metric)}</span><span>{i.name}</span>
              </div>
            ))}
          </div>
          {r.ingredients.length === 0 && <div className="muted">None yet. Tap Edit to add them.</div>}
        </div>

        <div className="card">
          <h2 className="h2">Steps</h2>
          {r.steps.map((s, n) => (
            <div key={n} className="row" style={{ gap: 12, alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700, color: 'var(--muted)', minWidth: 18 }}>{n + 1}</span><span>{s.text}</span>
            </div>
          ))}
          {r.steps.length === 0 && <div className="muted">None yet. Tap Edit to add them.</div>}
        </div>

        <div className="card">
          <h2 className="h2">Notes</h2>
          <textarea aria-label="Recipe notes" rows={3} placeholder="Add a note you both can see" value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if (notes !== r.notes) ctx.act(supabase.from('recipes').update({ notes }).eq('id', r.id), 'Note saved'); }} />
          <div className="muted">Saved for everyone in the book when you tap away.</div>
        </div>

        <div className="card">
          <h2 className="h2">Plan it</h2>
          <div className="wrap" style={{ gap: 6 }}>
            {days.map((day) => {
              const iso = isoDate(day);
              const on = d.plan.some((p) => p.plan_date === iso && p.recipe_id === r.id);
              return (
                <button key={iso} className={'chip tall' + (on ? ' on' : '')} style={{ padding: '0 12px' }} onClick={() => togglePlan(iso)}>
                  {day.toLocaleDateString(undefined, { weekday: 'short' })} {day.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card">
          <h2 className="h2">Cook log</h2>
          {logs.length === 0 && <div className="muted">Not made yet. Finish a cook in Make mode to log it here.</div>}
          <div className="divided">
            {logs.map((l) => (
              <div key={l.id} style={{ padding: '6px 0' }}>
                <div style={{ fontWeight: 600 }}>
                  {[new Date(l.cooked_on + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
                    l.rating ? l.rating + (l.rating === 1 ? ' star' : ' stars') : '', ctx.nameOf(l.user_id),
                    Number(l.scale) !== 1 ? 'made ' + fmtQty(Number(l.scale)) + '×' : ''].filter(Boolean).join(' · ')}
                </div>
                {l.note && <div className="muted">{l.note}</div>}
              </div>
            ))}
          </div>
        </div>

        {(r.source_photo_paths || []).some((p) => ctx.urls[p]) && (
          <div className="card">
            <h2 className="h2">Original card</h2>
            {r.source_photo_paths.filter((p) => ctx.urls[p]).map((p, n) => (
              <img key={p} src={ctx.urls[p]} alt={`Original card, photo ${n + 1}`} style={{ width: '100%', borderRadius: 12, display: 'block' }} />
            ))}
          </div>
        )}

        {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" className="muted">Original recipe page</a>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- make mode

export function Make({ ctx, r }: { ctx: Ctx; r: Recipe }) {
  const [scale, setScale] = useState(1);
  const [metric, setMetric] = useState(ctx.d.book.use_metric);
  const [awake, setAwake] = useState(true);
  const [doneIngs, setDoneIngs] = useState<Record<number, boolean>>({});
  const [doneSteps, setDoneSteps] = useState<Record<number, boolean>>({});
  const [mins, setMins] = useState<Record<number, number>>({});
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const canStayAwake = 'wakeLock' in navigator;

  // Ask the phone not to dim or lock while this screen is open.
  useEffect(() => {
    if (!awake || !canStayAwake) return;
    let lock: any;
    let gone = false;
    const get = async () => { try { lock = await (navigator as any).wakeLock.request('screen'); } catch { /* refused, e.g. low power mode */ } };
    const onVisible = () => { if (document.visibilityState === 'visible' && !gone) get(); };
    get();
    document.addEventListener('visibilitychange', onVisible);
    return () => { gone = true; document.removeEventListener('visibilitychange', onVisible); lock?.release?.().catch(() => {}); };
  }, [awake, canStayAwake]);

  const doneCount = r.steps.filter((_, n) => doneSteps[n]).length;

  async function saveLog() {
    setSaving(true);
    const ok = await ctx.act(supabase.from('cook_logs').insert({ recipe_id: r.id, scale, rating: rating || null, note: note.trim() }), 'Saved to the cook log');
    if (ok && rating) await setMark(ctx, r.id, { rating });
    setSaving(false);
    if (ok) ctx.go({ s: 'detail', id: r.id });
  }

  return (
    <div className="scroll"><div className="pad">
      <TopBar title={r.name} sub="Making" onBack={() => ctx.go({ s: 'detail', id: r.id })} />

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="h2">Amount</h2>
          {r.servings ? <span className="muted">Serves {fmtQty(r.servings * scale)}</span> : null}
        </div>
        <div className="row">
          {[[0.5, '½×'], [1, '1×'], [2, '2×'], [3, '3×']].map(([v, label]) => (
            <button key={label} className={'chip tall grow' + (scale === v ? ' on' : '')} onClick={() => setScale(v as number)}>{label}</button>
          ))}
        </div>
        <div className="row">
          <button className={'chip tall grow' + (!metric ? ' on' : '')} onClick={() => setMetric(false)}>US cups and ounces</button>
          <button className={'chip tall grow' + (metric ? ' on' : '')} onClick={() => setMetric(true)}>Metric</button>
        </div>
        {canStayAwake && (
          <button className="rowbtn" style={{ alignItems: 'center', justifyContent: 'space-between' }} onClick={() => setAwake(!awake)} aria-pressed={awake}>
            <span>Keep screen awake while cooking</span>
            <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{awake ? 'On' : 'Off'}</span>
          </button>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="h2">Gather ingredients</h2>
          <button className="linkbtn" onClick={() => addIngredientsToList(ctx, r, scale, metric)}>Add to list</button>
        </div>
        {r.ingredients.map((i, n) => (
          <button key={n} className="rowbtn" aria-pressed={!!doneIngs[n]} onClick={() => setDoneIngs({ ...doneIngs, [n]: !doneIngs[n] })}>
            <Check on={!!doneIngs[n]} />
            <span className={doneIngs[n] ? 'struck' : ''}><span style={{ fontWeight: 600 }}>{fmtAmt(i, scale, metric)}</span> {i.name}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="h2">Steps</h2>
          <span className="muted">{doneCount} of {r.steps.length} done</span>
        </div>
        <div className="divided">
          {r.steps.map((s, n) => {
            const m = mins[n] ?? s.minutes ?? 0;
            const done = !!doneSteps[n];
            return (
              <div key={n} style={{ paddingBottom: 8 }}>
                <button className="rowbtn" aria-pressed={done} onClick={() => setDoneSteps({ ...doneSteps, [n]: !done })}>
                  <Check on={done} />
                  <span className={done ? 'struck' : ''}><span style={{ fontWeight: 700 }}>{n + 1}.</span> {s.text}</span>
                </button>
                {s.minutes && !done ? (
                  <div className="timerpick">
                    <button className="iconbtn white" aria-label="One minute less" style={{ fontWeight: 700, fontSize: 18 }} onClick={() => setMins({ ...mins, [n]: Math.max(1, m - 1) })}>−</button>
                    <div className="grow" style={{ textAlign: 'center', fontWeight: 600 }}>{m} min</div>
                    <button className="iconbtn white" aria-label="One minute more" style={{ fontWeight: 700, fontSize: 18 }} onClick={() => setMins({ ...mins, [n]: m + 1 })}>+</button>
                    <button className="btn primary small" onClick={() => ctx.startTimer(`Step ${n + 1} · ${r.name}`, m * 60)}>
                      <Icon d={I.clock} size={18} />Start
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2 className="h2">Done cooking?</h2>
        <Stars value={rating} onSet={setRating} label="Rate this cook" />
        <input aria-label="Note about this cook" placeholder="How did it go? e.g. used less salt" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn dark" disabled={saving} onClick={saveLog}>Save to cook log</button>
      </div>
    </div></div>
  );
}

// ---------------------------------------------------------------- add / edit a recipe

export function AddMenu({ ctx }: { ctx: Ctx }) {
  const [mode, setMode] = useState<'' | 'photo' | 'link' | 'paste'>('');
  const [photos, setPhotos] = useState<Blob[]>([]);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const thumbs = useMemo(() => photos.map((p) => URL.createObjectURL(p)), [photos]);
  useEffect(() => () => thumbs.forEach((u) => URL.revokeObjectURL(u)), [thumbs]);

  async function run(label: string, job: () => Promise<Draft>) {
    setBusy(label); setError(''); setProgress(0);
    try { ctx.go({ s: 'edit', draft: await job() }); }
    catch (e: any) { setError(e?.message || 'That did not work. Please try again.'); setBusy(''); }
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    try {
      const added: Blob[] = [];
      for (const f of Array.from(files)) added.push(await shrinkPhoto(f, 2000));
      setPhotos([...photos, ...added]);
    } catch { setError('That photo could not be opened. Try taking it again.'); }
  }

  const readCards = () => run('Reading the text', async () => {
    const found = await readPhotos(photos, setProgress);
    const draft = textToDraft(found);
    draft.sourceType = 'photo';
    draft.photos = photos;
    draft.notice = found.trim()
      ? 'Text read from your photo. Compare it with the card and fix any mistakes before saving.'
      : 'No text could be read from the photo. You can type the recipe in, and the photo is kept with it.';
    return draft;
  });

  const readFile = (file: File | undefined) => file && run('Reading the PDF', async () => {
    const { text: found, scanned } = await readPdf(file, setProgress);
    const draft = textToDraft(found);
    draft.sourceType = 'pdf';
    draft.notice = scanned
      ? 'This PDF is a scan, so the text was read from its pictures. Check it carefully before saving.'
      : 'Read from your PDF. Check it over and fix anything that looks off.';
    return draft;
  });

  if (busy) {
    return (
      <div className="center" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="h2">{busy}…</div>
        {progress > 0 && <progress value={progress} max={1} style={{ width: '70%' }} aria-label={busy} />}
        <div className="muted">The first time can take a little longer.</div>
      </div>
    );
  }

  const option = (icon: string, tile: string[], title: string, sub: string) => (
    <>
      <span className="iconbtn" style={{ background: tile[0], color: tile[1] }}><Icon d={icon} /></span>
      <span className="grow"><span style={{ fontWeight: 600, display: 'block' }}>{title}</span><span className="muted">{sub}</span></span>
    </>
  );
  const optionStyle = { flexDirection: 'row' as const, alignItems: 'center', gap: 14, width: '100%', cursor: 'pointer' };

  return (
    <div className="scroll"><div className="pad">
      {mode === '' && (
        <>
          <div>
            <div className="muted">Goes into {ctx.d.book.name}</div>
            <h1 className="h1">Add a recipe</h1>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="card" style={optionStyle} onClick={() => { setMode('photo'); setError(''); }}>
            {option(I.camera, TILES[0], 'Photograph a recipe card', 'One or more photos, turned into text you can fix')}
          </button>
          <button className="card" style={optionStyle} onClick={() => { setMode('link'); setError(''); }}>
            {option(I.link, TILES[3], 'Paste a link', 'Pulls the recipe from a web page')}
          </button>
          <label className="card" style={optionStyle}>
            {option(I.file, TILES[1], 'Upload a PDF', 'From Files, email or iCloud Drive')}
            <input type="file" accept="application/pdf" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <button className="card" style={optionStyle} onClick={() => { setMode('paste'); setError(''); }}>
            {option(I.list, TILES[4], 'Paste text', 'Copied from a message, note or website')}
          </button>
          <button className="card" style={optionStyle} onClick={() => ctx.go({ s: 'edit' })}>
            {option(I.pencil, TILES[5], 'Type it in', 'Start from a blank recipe')}
          </button>
        </>
      )}

      {mode === 'photo' && (
        <>
          <TopBar title="Photograph the card" onBack={() => setMode('')} />
          {error && <div className="error">{error}</div>}
          <div className="muted">Flat, well lit and filling the frame works best. Printed cards read well; handwriting usually needs more fixing. Take one photo per side or page.</div>
          {thumbs.length > 0 && (
            <div className="grid2">
              {thumbs.map((src, n) => (
                <div key={src} style={{ position: 'relative' }}>
                  <img src={src} alt={`Photo ${n + 1}`} style={{ width: '100%', height: 150, objectFit: 'cover', borderRadius: 14, display: 'block' }} />
                  <button className="iconbtn white" aria-label={`Remove photo ${n + 1}`} style={{ position: 'absolute', top: 4, right: 4, width: 36, height: 36 }}
                    onClick={() => setPhotos(photos.filter((_, i) => i !== n))}><Icon d={I.x} size={16} /></button>
                </div>
              ))}
            </div>
          )}
          <label className="btn" style={{ cursor: 'pointer' }}>
            <Icon d={I.camera} size={18} />Take a photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Choose from your photos
            <input type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
          </label>
          {photos.length > 0 && <button className="btn primary" onClick={readCards}>Read the text</button>}
        </>
      )}

      {mode === 'link' && (
        <form className="stack" style={{ gap: 16 }} onSubmit={(e) => { e.preventDefault(); run('Opening the page', () => readLink(url)); }}>
          <TopBar title="Paste a link" onBack={() => setMode('')} />
          {error && <div className="error">{error}</div>}
          <input type="url" aria-label="Recipe web address" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" required />
          <div className="muted">The app reads the page and keeps only the recipe.</div>
          <button className="btn primary" disabled={!url.trim()}>Get the recipe</button>
        </form>
      )}

      {mode === 'paste' && (
        <>
          <TopBar title="Paste text" onBack={() => setMode('')} />
          <textarea rows={12} aria-label="Recipe text" placeholder="Paste the whole recipe here" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn primary" disabled={!text.trim()}
            onClick={() => ctx.go({ s: 'edit', draft: { ...textToDraft(text), notice: 'Sorted from the text you pasted. Check it over before saving.' } })}>
            Sort it into a recipe
          </button>
        </>
      )}
    </div></div>
  );
}

export function Edit({ ctx, r, draft }: { ctx: Ctx; r?: Recipe; draft?: Draft }) {
  const { d } = ctx;
  const [name, setName] = useState(r?.name || draft?.name || '');
  const [servings, setServings] = useState(r?.servings ? String(r.servings) : draft?.servings || '');
  const [minutes, setMinutes] = useState(r?.total_minutes ? String(r.total_minutes) : draft?.minutes || '');
  const [ings, setIngs] = useState(r ? ingredientsToText(r.ingredients) : draft?.ings || '');
  const [steps, setSteps] = useState(r ? r.steps.map((s) => s.text).join('\n') : draft?.steps || '');
  const [url, setUrl] = useState(r?.source_url || draft?.url || '');
  const [tagIds, setTagIds] = useState<string[]>(r ? tagIdsOf(ctx, r.id) : []);
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(false);
  const back = () => ctx.go(r ? { s: 'detail', id: r.id } : { s: 'add' });
  const cardPhotos = useMemo(() => (draft?.photos || []).map((p) => URL.createObjectURL(p)), [draft]);
  useEffect(() => () => cardPhotos.forEach((u) => URL.revokeObjectURL(u)), [cardPhotos]);

  async function addTag() {
    const tagName = newTag.trim();
    if (!tagName) return;
    const existing = d.tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    if (existing) { setTagIds([...new Set([...tagIds, existing.id])]); setNewTag(''); return; }
    const { data, error } = await supabase.from('tags').insert({ book_id: d.book.id, name: tagName }).select('id').single();
    if (error) { ctx.toast(error.message); return; }
    await ctx.reload();
    setTagIds([...tagIds, data.id]);
    setNewTag('');
  }

  async function save() {
    if (!name.trim()) { ctx.toast('Give the recipe a name first'); return; }
    setBusy(true);
    const parsedSteps = lines(steps).map(parseStep);
    const stepMinutes = parsedSteps.reduce((sum, s) => sum + (s.minutes || 0), 0);
    const fields = {
      name: name.trim(),
      servings: Number(servings) > 0 ? Number(servings) : null,
      total_minutes: Number(minutes) > 0 ? Math.round(Number(minutes)) : stepMinutes || null,
      ingredients: lines(ings).map(parseIngredient),
      steps: parsedSteps,
      source_url: url.trim() || null,
    };
    let id = r?.id;
    if (id) {
      const { error } = await supabase.from('recipes').update(fields).eq('id', id);
      if (error) { ctx.toast(error.message); setBusy(false); return; }
    } else {
      const { data, error } = await supabase.from('recipes').insert({ ...fields, book_id: d.book.id, added_by: ctx.userId, source_type: draft?.sourceType || 'manual' }).select('id').single();
      if (error) { ctx.toast(error.message); setBusy(false); return; }
      id = data.id as string;
      // Keep the pictures of the original card with the recipe.
      const paths: string[] = [];
      for (const [n, photo] of (draft?.photos || []).entries()) {
        const path = `${d.book.id}/${id}/card-${n + 1}.jpg`;
        const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, photo, { contentType: 'image/jpeg' });
        if (!up.error) paths.push(path);
      }
      if (paths.length) await supabase.from('recipes').update({ source_photo_paths: paths }).eq('id', id);
    }
    const before = r ? tagIdsOf(ctx, r.id) : [];
    const remove = before.filter((t) => !tagIds.includes(t));
    const add = tagIds.filter((t) => !before.includes(t));
    if (remove.length) await supabase.from('recipe_tags').delete().eq('recipe_id', id).in('tag_id', remove);
    if (add.length) await supabase.from('recipe_tags').insert(add.map((tag_id) => ({ recipe_id: id, tag_id })));
    await ctx.reload();
    setBusy(false);
    ctx.toast('Saved to ' + d.book.name);
    ctx.go({ s: 'detail', id });
  }

  async function remove() {
    if (!r || !window.confirm(`Delete "${r.name}" for everyone in the book? This cannot be undone.`)) return;
    if (await ctx.act(supabase.from('recipes').delete().eq('id', r.id), 'Recipe deleted')) ctx.go({ s: 'home' });
  }

  return (
    <div className="scroll"><div className="pad">
      <TopBar title={r ? 'Edit recipe' : draft?.notice ? 'Review before saving' : 'New recipe'} onBack={back} />
      {draft?.notice && <div className="notice">{draft.notice}</div>}
      {cardPhotos.length > 0 && (
        <div className="chips-scroll">
          {cardPhotos.map((src, n) => (
            <a key={src} href={src} target="_blank" rel="noreferrer" style={{ flex: 'none' }}>
              <img src={src} alt={`Original card, photo ${n + 1}`} style={{ height: 220, maxWidth: 300, objectFit: 'contain', borderRadius: 12, display: 'block', background: 'var(--soft)' }} />
            </a>
          ))}
        </div>
      )}
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipe name" /></Field>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Field label="Serves"><input inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} placeholder="4" /></Field>
        <Field label="Total minutes"><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="From steps" /></Field>
      </div>
      <Field label="Ingredients" hint="one per line">
        <textarea rows={7} value={ings} onChange={(e) => setIngs(e.target.value)} placeholder={'1 1/2 cups flour\n2 tbsp butter\n1 egg'} autoCapitalize="off" />
      </Field>
      <div className="stack">
        <Field label="Steps" hint="one per line">
          <textarea rows={7} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'Heat the oven to 350°F.\nBake for 20 minutes.'} />
        </Field>
        <div className="muted">Times written in a step, like "20 minutes", become timer suggestions.</div>
      </div>
      <div className="stack">
        <div style={{ fontWeight: 600 }}>Tags</div>
        <div className="wrap">
          {d.tags.map((t) => {
            const on = tagIds.includes(t.id);
            return <button key={t.id} className={'chip tall' + (on ? ' on' : '')} onClick={() => setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id])}>{t.name}</button>;
          })}
        </div>
        <div className="row">
          <input aria-label="New tag name" placeholder="New tag, e.g. Holidays" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
          <button className="btn dark small" onClick={addTag}>Add</button>
        </div>
      </div>
      <Field label="Web link" hint="optional"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoCapitalize="off" /></Field>
      <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save to book'}</button>
      {r && <button className="btn danger" onClick={remove}>Delete recipe</button>}
    </div></div>
  );
}

// ---------------------------------------------------------------- meal plan

export function Plan({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const [weekOffset, setWeekOffset] = useState(0);
  const today = new Date();
  const monday = addDays(today, -((today.getDay() + 6) % 7) + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const todayIso = isoDate(today);
  const range = `${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  return (
    <div className="scroll"><div className="pad">
      <div>
        <div className="muted">Shared with everyone in the book</div>
        <h1 className="h1">{weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : range}</h1>
      </div>
      <div className="row">
        <button className="btn" onClick={() => setWeekOffset(weekOffset - 1)}>Earlier</button>
        {weekOffset !== 0 && <button className="btn" onClick={() => setWeekOffset(0)}>Today</button>}
        <button className="btn" onClick={() => setWeekOffset(weekOffset + 1)}>Later</button>
      </div>
      {days.map((day) => {
        const iso = isoDate(day);
        const entries = d.plan.filter((p) => p.plan_date === iso);
        return (
          <div key={iso} className="card" style={{ padding: '10px 12px', borderColor: iso === todayIso ? 'var(--ink)' : undefined }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div style={{ width: 48, paddingTop: 10 }}>
                <div style={{ fontWeight: 700 }}>{day.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div className="muted">{day.getDate()}</div>
              </div>
              <div className="grow stack">
                {entries.length === 0 && <div className="muted" style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>Nothing planned</div>}
                {entries.map((p) => {
                  const r = d.recipes.find((x) => x.id === p.recipe_id);
                  if (!r) return null;
                  return (
                    <div key={p.id} className="row">
                      <button className="row grow" style={{ minHeight: 44, gap: 10 }} onClick={() => ctx.go({ s: 'detail', id: r.id })}>
                        <span style={{ width: 40, flex: 'none' }}><Photo ctx={ctx} r={r} height={40} radius={10} /></span>
                        <span style={{ fontWeight: 600 }}>{r.name}</span>
                      </button>
                      <button className="iconbtn" aria-label={`Remove ${r.name} from the plan`} onClick={() => ctx.act(supabase.from('meal_plan').delete().eq('id', p.id))}>
                        <Icon d={I.x} size={18} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      <div className="muted">To plan a meal, open a recipe and pick a day under "Plan it".</div>
    </div></div>
  );
}

// ---------------------------------------------------------------- shopping list

export function Shopping({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const [text, setText] = useState('');
  const doneIds = d.shopping.filter((i) => i.done).map((i) => i.id);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await ctx.act(supabase.from('shopping_items').insert({ book_id: d.book.id, text: text.trim() }))) setText('');
  }

  return (
    <div className="scroll"><div className="pad">
      <div>
        <div className="muted">Shared with everyone in the book</div>
        <h1 className="h1">Shopping list</h1>
      </div>
      <form className="row" onSubmit={add}>
        <input aria-label="Add an item" placeholder="Add an item" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn dark small">Add</button>
      </form>
      {d.shopping.length === 0 && (
        <div className="card" style={{ alignItems: 'center', textAlign: 'center', padding: '28px 16px' }}>
          <div className="h2">Nothing to buy</div>
          <div className="muted">Open a recipe and tap "Add to shopping list".</div>
        </div>
      )}
      <div className="divided">
        {d.shopping.map((i) => {
          const from = i.recipe_id ? d.recipes.find((r) => r.id === i.recipe_id)?.name : 'Added by ' + ctx.nameOf(i.added_by).replace('You', 'you');
          return (
            <button key={i.id} className="rowbtn" aria-pressed={i.done} onClick={() => ctx.act(supabase.from('shopping_items').update({ done: !i.done }).eq('id', i.id))}>
              <Check on={i.done} />
              <span className="grow">
                <span className={i.done ? 'struck' : ''} style={{ display: 'block' }}>{i.text}</span>
                {from && <span className="muted">{from}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {doneIds.length > 0 && (
        <button className="btn" onClick={() => ctx.act(supabase.from('shopping_items').delete().in('id', doneIds))}>Clear checked items</button>
      )}
    </div></div>
  );
}

// ---------------------------------------------------------------- book settings

export function BookSettings({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const me = d.members.find((m) => m.user_id === ctx.userId);
  const [bookName, setBookName] = useState(d.book.name);
  const [myName, setMyName] = useState(me?.name || '');
  const [newTag, setNewTag] = useState('');
  const [code, setCode] = useState('');

  async function renameBook() {
    const next = bookName.trim();
    if (!next || next === d.book.name) { setBookName(d.book.name); return; }
    if (await ctx.act(supabase.from('books').update({ name: next }).eq('id', d.book.id), 'Book renamed')) ctx.reloadBooks();
  }
  async function invite() {
    const { data, error } = await supabase.rpc('create_invite', { p_book: d.book.id });
    if (error) ctx.toast(error.message);
    else setCode(data as string);
  }
  async function shareCode() {
    const message = `Join our recipe book "${d.book.name}". Open the app, create your account, choose "Join with a code" and enter: ${code}`;
    try {
      if (navigator.share) await navigator.share({ text: message });
      else { await navigator.clipboard.writeText(message); ctx.toast('Invite copied'); }
    } catch { /* share sheet closed */ }
  }
  async function addTag(e: FormEvent) {
    e.preventDefault();
    if (!newTag.trim()) return;
    if (await ctx.act(supabase.from('tags').insert({ book_id: d.book.id, name: newTag.trim() }))) setNewTag('');
  }

  return (
    <div className="scroll"><div className="pad">
      <div>
        <div className="muted">Your shared book</div>
        <h1 className="h1">Book settings</h1>
      </div>

      <div className="card">
        <Field label="Book name"><input value={bookName} onChange={(e) => setBookName(e.target.value)} onBlur={renameBook} /></Field>
      </div>

      <div className="card">
        <h2 className="h2">Members</h2>
        {d.members.map((m) => (
          <div key={m.user_id} className="row" style={{ gap: 12 }}>
            <span className="iconbtn" style={{ fontWeight: 700 }}>{(m.name || '?').charAt(0).toUpperCase()}</span>
            <span className="grow">
              <span style={{ fontWeight: 600, display: 'block' }}>{m.name}{m.user_id === ctx.userId ? ' (you)' : ''}</span>
              <span className="muted">{m.role === 'owner' ? 'Owner' : 'Can add, edit and cook'}</span>
            </span>
          </div>
        ))}
        {code ? (
          <>
            <div className="notice">Invite code: <strong style={{ letterSpacing: '0.08em' }}>{code}</strong><br />Works for 14 days.</div>
            <button className="btn dark" onClick={shareCode}>Send the invite</button>
          </>
        ) : <button className="btn" onClick={invite}>Invite someone</button>}
      </div>

      <div className="card">
        <h2 className="h2">Tags</h2>
        <div className="wrap">
          {d.tags.map((t) => (
            <span key={t.id} className="row" style={{ background: 'var(--soft)', borderRadius: 22, paddingLeft: 14, gap: 0, fontSize: 14, fontWeight: 500 }}>
              {t.name}
              <button className="iconbtn" aria-label={`Delete the tag ${t.name}`} style={{ background: 'none' }}
                onClick={() => { if (window.confirm(`Delete the tag "${t.name}"? Recipes keep everything else.`)) ctx.act(supabase.from('tags').delete().eq('id', t.id)); }}>
                <Icon d={I.x} size={16} />
              </button>
            </span>
          ))}
          {d.tags.length === 0 && <div className="muted">No tags yet. Add ones like Dinner, Baking or Holidays.</div>}
        </div>
        <form className="row" onSubmit={addTag}>
          <input aria-label="New tag name" placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
          <button className="btn dark small">Add</button>
        </form>
      </div>

      <div className="card">
        <h2 className="h2">Measurements</h2>
        <div className="row">
          <button className={'chip tall grow' + (!d.book.use_metric ? ' on' : '')} onClick={() => ctx.act(supabase.from('books').update({ use_metric: false }).eq('id', d.book.id))}>US cups and ounces</button>
          <button className={'chip tall grow' + (d.book.use_metric ? ' on' : '')} onClick={() => ctx.act(supabase.from('books').update({ use_metric: true }).eq('id', d.book.id))}>Metric</button>
        </div>
      </div>

      <div className="card">
        <button className="rowbtn" style={{ alignItems: 'center', justifyContent: 'space-between' }} aria-pressed={d.book.yearly_pdf_enabled}
          onClick={() => ctx.act(supabase.from('books').update({ yearly_pdf_enabled: !d.book.yearly_pdf_enabled }).eq('id', d.book.id))}>
          <span className="h2">Yearly PDF keepsake</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{d.book.yearly_pdf_enabled ? 'On' : 'Off'}</span>
        </button>
        <div className="muted">Once a year the whole book is saved as a PDF and emailed to every member. The emailing itself is added in a later stage; this switch is remembered for then.</div>
      </div>

      <div className="card">
        <h2 className="h2">You</h2>
        <Field label="Your name">
          <input value={myName} onChange={(e) => setMyName(e.target.value)}
            onBlur={() => { if (myName.trim() && myName.trim() !== me?.name) ctx.act(supabase.from('profiles').update({ display_name: myName.trim() }).eq('id', ctx.userId), 'Name saved'); }} />
        </Field>
        {ctx.books.length > 1 && (
          <div className="stack">
            <div style={{ fontWeight: 600 }}>Your books</div>
            <div className="wrap">
              {ctx.books.map((b) => <button key={b.id} className={'chip tall' + (b.id === d.book.id ? ' on' : '')} onClick={() => ctx.switchBook(b.id)}>{b.name}</button>)}
            </div>
          </div>
        )}
        <button className="btn" onClick={ctx.addBook}>Start or join another book</button>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div></div>
  );
}
