import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { configured, supabase } from './supabase';
import { useBook, type Book, type BookData } from './data';
import { clock } from './format';
import type { Draft } from './importers';
import { AddMenu, Auth, BookGate, BookSettings, Detail, Edit, Home, I, Icon, Make, Plan, Shopping } from './screens';

export type View = { s: 'home' | 'plan' | 'add' | 'shop' | 'book' | 'detail' | 'make' | 'edit'; id?: string; draft?: Draft };

/** Everything a screen needs: the book's data and the ways to change things. */
export type Ctx = {
  d: BookData;
  userId: string;
  urls: Record<string, string>;
  books: Book[];
  reload: () => Promise<void>;
  /** Runs a database change, shows any error, then refreshes. Returns true if it worked. */
  act: (change: PromiseLike<{ error: any }>, okMessage?: string) => Promise<boolean>;
  go: (v: View) => void;
  toast: (message: string) => void;
  startTimer: (label: string, seconds: number) => void;
  nameOf: (userId: string | null) => string;
  switchBook: (id: string) => void;
  addBook: () => void;
  reloadBooks: () => Promise<void>;
};

const remember = {
  get: (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured) {
    return (
      <div className="app"><div className="center">
        <h1 className="h1">Almost there</h1>
        <div className="notice">The database key has not been added yet. It goes in src/config.ts.</div>
      </div></div>
    );
  }
  if (session === undefined) return <Splash />;
  if (!session) return <div className="app"><Auth /></div>;
  return <Signed userId={session.user.id} />;
}

function Splash({ text = 'Loading…' }: { text?: string }) {
  return <div className="app"><div className="center muted" style={{ alignItems: 'center' }}>{text}</div></div>;
}

function Signed({ userId }: { userId: string }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState('');
  const [bookId, setBookId] = useState(remember.get('bookId'));
  const [adding, setAdding] = useState(false);

  const loadBooks = useCallback(async () => {
    const { data, error } = await supabase.from('books').select('*').order('created_at');
    if (error) setError(error.message);
    else { setBooks((data || []) as Book[]); setError(''); }
  }, []);
  useEffect(() => { loadBooks(); }, [loadBooks]);

  const choose = (id: string) => { remember.set('bookId', id); setBookId(id); };

  if (error && !books) {
    return (
      <div className="app"><div className="center">
        <div className="error">Could not reach the database: {error}</div>
        <button className="btn" onClick={loadBooks}>Try again</button>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div></div>
    );
  }
  if (!books) return <Splash />;

  const current = books.find((b) => b.id === bookId) || books[0];
  if (!current || adding) {
    return (
      <div className="app">
        <BookGate
          onDone={async (id) => { await loadBooks(); choose(id); setAdding(false); }}
          onCancel={current ? () => setAdding(false) : undefined}
        />
      </div>
    );
  }
  return (
    <BookApp key={current.id} bookId={current.id} userId={userId} books={books}
      switchBook={choose} addBook={() => setAdding(true)} reloadBooks={loadBooks} />
  );
}

type Timer = { label: string; endAt: number | null; left: number };

function BookApp(props: {
  bookId: string; userId: string; books: Book[];
  switchBook: (id: string) => void; addBook: () => void; reloadBooks: () => Promise<void>;
}) {
  const { data, error, urls, reload } = useBook(props.bookId);
  const [view, setView] = useState<View>({ s: 'home' });
  const [toastText, setToastText] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [timer, setTimer] = useState<Timer | null>(null);
  const [, setTick] = useState(0);
  const audio = useRef<AudioContext | null>(null);
  const rang = useRef(false);

  const toast = useCallback((message: string) => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 2600);
  }, []);

  // Timer: counts against the clock, so it stays right if the phone was briefly locked.
  const left = timer ? (timer.endAt ? Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000)) : timer.left) : 0;
  const running = !!timer?.endAt && left > 0;
  const finished = !!timer?.endAt && left === 0;

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(iv);
  }, [running]);

  useEffect(() => {
    if (!finished || rang.current) return;
    rang.current = true;
    const ctx = audio.current;
    if (ctx) {
      for (let i = 0; i < 4; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        osc.connect(gain); gain.connect(ctx.destination);
        const at = ctx.currentTime + i * 0.45;
        gain.gain.setValueAtTime(0.3, at);
        osc.start(at); osc.stop(at + 0.25);
      }
    }
    navigator.vibrate?.([300, 150, 300]);
  }, [finished]);

  const startTimer = useCallback((label: string, seconds: number) => {
    // Sound has to be unlocked by a tap, and this runs from the Start button.
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      audio.current = audio.current || new AC();
      audio.current.resume();
    } catch { /* no sound available */ }
    rang.current = false;
    setTimer({ label, endAt: Date.now() + seconds * 1000, left: seconds });
  }, []);

  if (error && !data) {
    return (
      <div className="app"><div className="center">
        <div className="error">Could not load the book: {error}</div>
        <button className="btn" onClick={reload}>Try again</button>
      </div></div>
    );
  }
  if (!data) return <Splash text="Opening your book…" />;

  const ctx: Ctx = {
    d: data, userId: props.userId, urls, books: props.books, reload,
    act: async (change, okMessage) => {
      const { error } = await change;
      if (error) { toast(error.message || 'That did not save. Check your connection.'); return false; }
      await reload();
      if (okMessage) toast(okMessage);
      return true;
    },
    go: setView, toast, startTimer,
    nameOf: (id) => (id === props.userId ? 'You' : data.members.find((m) => m.user_id === id)?.name || 'Someone'),
    switchBook: props.switchBook, addBook: props.addBook, reloadBooks: props.reloadBooks,
  };

  const recipe = view.id ? data.recipes.find((r) => r.id === view.id) : undefined;
  const needsRecipe = view.s === 'detail' || view.s === 'make' || (view.s === 'edit' && view.id);
  const s = needsRecipe && !recipe ? 'home' : view.s;
  const tab = s === 'detail' || s === 'make' || s === 'edit' ? (view.id ? 'home' : 'add') : s;

  const tabs: [View['s'], string, string][] = [
    ['home', 'Recipes', I.book], ['plan', 'Plan', I.calendar], ['add', 'Add', I.plus],
    ['shop', 'Shopping', I.list], ['book', 'Book', I.person],
  ];

  return (
    <div className="app">
      {s === 'home' && <Home ctx={ctx} />}
      {s === 'detail' && recipe && <Detail ctx={ctx} r={recipe} />}
      {s === 'make' && recipe && <Make ctx={ctx} r={recipe} />}
      {s === 'edit' && <Edit ctx={ctx} r={recipe} draft={view.draft} />}
      {s === 'plan' && <Plan ctx={ctx} />}
      {s === 'add' && <AddMenu ctx={ctx} />}
      {s === 'shop' && <Shopping ctx={ctx} />}
      {s === 'book' && <BookSettings ctx={ctx} />}

      {toastText && <div className="toast" role="status">{toastText}</div>}

      {timer && (
        <div className={'timerbar' + (finished ? ' done' : '')}>
          <div className="grow">
            <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {finished ? 'Time is up · ' : ''}{timer.label}
            </div>
            <div className="time">{finished ? 'Done' : clock(left)}</div>
          </div>
          {!finished && (
            <>
              <button onClick={() => setTimer(timer.endAt ? { ...timer, endAt: timer.endAt + 60000 } : { ...timer, left: timer.left + 60 })}>+1 min</button>
              <button onClick={() => setTimer(timer.endAt ? { ...timer, endAt: null, left } : { ...timer, endAt: Date.now() + timer.left * 1000 })}>
                {timer.endAt ? 'Pause' : 'Resume'}
              </button>
            </>
          )}
          <button onClick={() => setTimer(null)}>{finished ? 'Dismiss' : 'Cancel'}</button>
        </div>
      )}

      <nav className="tabbar" aria-label="Main">
        {tabs.map(([key, name, icon]) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setView({ s: key })}>
            <Icon d={icon} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
