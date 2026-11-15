-- Recipe book app: database layout and access rules.
-- Paste this whole file into the Supabase SQL Editor and press Run, once, on a new project.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

-- Give every new sign-up a profile row automatically.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Books and who belongs to them
-- ---------------------------------------------------------------------------
create table public.books (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  owner_id uuid not null references auth.users (id),
  yearly_pdf_enabled boolean not null default true,
  use_metric boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.book_members (
  book_id uuid not null references public.books (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (book_id, user_id)
);
create index book_members_user_idx on public.book_members (user_id);

create table public.book_invites (
  code text primary key,
  book_id uuid not null references public.books (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now()
);

-- The one question every access rule asks: is the signed-in person a member of this book?
create function public.is_book_member(p_book uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.book_members
    where book_id = p_book and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  servings numeric,
  total_minutes integer,
  -- ingredients: [{"qty": 1.5, "unit": "cup", "name": "flour"}, ...]   (qty and unit may be null)
  ingredients jsonb not null default '[]'::jsonb,
  -- steps: [{"text": "Bake until golden", "minutes": 22}, ...]          (minutes may be null)
  steps jsonb not null default '[]'::jsonb,
  notes text not null default '',
  source_type text not null default 'manual' check (source_type in ('manual', 'photo', 'link', 'pdf')),
  source_url text,
  photo_path text,           -- finished-dish photo, a path in the recipe-photos bucket
  source_photo_paths text[] not null default '{}',  -- photos of the original card
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector
);
create index recipes_book_idx on public.recipes (book_id);
create index recipes_search_idx on public.recipes using gin (search);

-- Keep the search index and "last edited" time current on every save.
create function public.recipes_before_save() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.search :=
    setweight(to_tsvector('english', new.name), 'A') ||
    setweight(to_tsvector('english', coalesce(
      (select string_agg(i ->> 'name', ' ') from jsonb_array_elements(new.ingredients) as i), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.notes, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(
      (select string_agg(s ->> 'text', ' ') from jsonb_array_elements(new.steps) as s), '')), 'D');
  return new;
end $$;

create trigger recipes_before_save
  before insert or update on public.recipes
  for each row execute function public.recipes_before_save();

-- ---------------------------------------------------------------------------
-- Tags (made by you, per book)
-- ---------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);
create unique index tags_book_name_idx on public.tags (book_id, lower(name));

create table public.recipe_tags (
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  primary key (recipe_id, tag_id)
);
create index recipe_tags_tag_idx on public.recipe_tags (tag_id);

-- ---------------------------------------------------------------------------
-- Per-person favorites and ratings
-- ---------------------------------------------------------------------------
create table public.recipe_marks (
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  favorite boolean not null default false,
  rating smallint check (rating between 1 and 5),
  primary key (recipe_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Cook log
-- ---------------------------------------------------------------------------
create table public.cook_logs (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  cooked_on date not null default current_date,
  scale numeric not null default 1,
  rating smallint check (rating between 1 and 5),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index cook_logs_recipe_idx on public.cook_logs (recipe_id);

-- ---------------------------------------------------------------------------
-- Shopping list and meal plan (shared per book)
-- ---------------------------------------------------------------------------
create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  text text not null check (length(trim(text)) > 0),
  recipe_id uuid references public.recipes (id) on delete set null,
  done boolean not null default false,
  added_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index shopping_items_book_idx on public.shopping_items (book_id);

create table public.meal_plan (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  plan_date date not null,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  added_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (book_id, plan_date, recipe_id)
);
create index meal_plan_book_date_idx on public.meal_plan (book_id, plan_date);

-- A recipe's book, for rules on tables that hang off a recipe.
create function public.recipe_book(p_recipe uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select book_id from public.recipes where id = p_recipe;
$$;

-- ---------------------------------------------------------------------------
-- Actions the app calls
-- ---------------------------------------------------------------------------

-- Create a book and make the caller its owner.
create function public.create_book(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.books (name, owner_id) values (trim(p_name), auth.uid()) returning id into v_id;
  insert into public.book_members (book_id, user_id, role) values (v_id, auth.uid(), 'owner');
  return v_id;
end $$;

-- Make an invite code for a book you belong to. Valid for 14 days.
create function public.create_invite(p_book uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
begin
  if not public.is_book_member(p_book) then raise exception 'Not a member of this book'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.book_invites (code, book_id, created_by) values (v_code, p_book, auth.uid());
  return v_code;
end $$;

-- Join a book using an invite code.
create function public.join_book(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_book uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select book_id into v_book from public.book_invites
  where code = upper(trim(p_code)) and expires_at > now();
  if v_book is null then raise exception 'This invite code is not valid or has expired'; end if;
  insert into public.book_members (book_id, user_id) values (v_book, auth.uid())
  on conflict do nothing;
  return v_book;
end $$;

revoke execute on function public.create_book(text), public.create_invite(uuid), public.join_book(text) from public, anon;
grant execute on function public.create_book(text), public.create_invite(uuid), public.join_book(text) to authenticated;
revoke execute on function public.is_book_member(uuid), public.recipe_book(uuid) from public, anon;
grant execute on function public.is_book_member(uuid), public.recipe_book(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Access rules: only members of a book can see or change anything in it
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.book_members enable row level security;
alter table public.book_invites enable row level security;
alter table public.recipes enable row level security;
alter table public.tags enable row level security;
alter table public.recipe_tags enable row level security;
alter table public.recipe_marks enable row level security;
alter table public.cook_logs enable row level security;
alter table public.shopping_items enable row level security;
alter table public.meal_plan enable row level security;

-- Profiles: you see yourself and the people you share a book with; you edit only yourself.
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.book_members m
      where m.user_id = profiles.id and public.is_book_member(m.book_id)
    )
  );
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Books: members read and rename; only the owner deletes. Creating goes through create_book().
create policy books_select on public.books for select to authenticated
  using (public.is_book_member(id));
create policy books_update on public.books for update to authenticated
  using (public.is_book_member(id)) with check (public.is_book_member(id));
create policy books_delete on public.books for delete to authenticated
  using (owner_id = auth.uid());

-- Members: you see who is in your books; you can leave; the owner can remove someone.
-- Joining goes through join_book().
create policy members_select on public.book_members for select to authenticated
  using (public.is_book_member(book_id));
create policy members_delete on public.book_members for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.books b where b.id = book_id and b.owner_id = auth.uid())
  );

-- Invites: members can see and cancel their book's invites. Creating goes through create_invite().
create policy invites_select on public.book_invites for select to authenticated
  using (public.is_book_member(book_id));
create policy invites_delete on public.book_invites for delete to authenticated
  using (public.is_book_member(book_id));

-- Everything stored directly under a book.
create policy recipes_all on public.recipes for all to authenticated
  using (public.is_book_member(book_id)) with check (public.is_book_member(book_id));
create policy tags_all on public.tags for all to authenticated
  using (public.is_book_member(book_id)) with check (public.is_book_member(book_id));
create policy shopping_all on public.shopping_items for all to authenticated
  using (public.is_book_member(book_id)) with check (public.is_book_member(book_id));
create policy meal_plan_all on public.meal_plan for all to authenticated
  using (public.is_book_member(book_id)) with check (public.is_book_member(book_id));

-- Things that hang off a recipe.
create policy recipe_tags_all on public.recipe_tags for all to authenticated
  using (public.is_book_member(public.recipe_book(recipe_id)))
  with check (public.is_book_member(public.recipe_book(recipe_id)));

-- Favorites and ratings: everyone in the book can see them, you change only your own.
create policy marks_select on public.recipe_marks for select to authenticated
  using (public.is_book_member(public.recipe_book(recipe_id)));
create policy marks_insert on public.recipe_marks for insert to authenticated
  with check (user_id = auth.uid() and public.is_book_member(public.recipe_book(recipe_id)));
create policy marks_update on public.recipe_marks for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy marks_delete on public.recipe_marks for delete to authenticated
  using (user_id = auth.uid());

-- Cook log: everyone in the book can read it, you write only your own entries.
create policy logs_select on public.cook_logs for select to authenticated
  using (public.is_book_member(public.recipe_book(recipe_id)));
create policy logs_insert on public.cook_logs for insert to authenticated
  with check (user_id = auth.uid() and public.is_book_member(public.recipe_book(recipe_id)));
create policy logs_update on public.cook_logs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy logs_delete on public.cook_logs for delete to authenticated
  using (user_id = auth.uid());

-- Table permissions for signed-in people (the rules above decide which rows).
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert on public.books, public.book_members, public.book_invites from authenticated;
revoke update on public.book_members, public.book_invites from authenticated;

-- ---------------------------------------------------------------------------
-- Photos: a private bucket; files are stored as <book id>/<recipe id>/<file name>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('recipe-photos', 'recipe-photos', false)
on conflict (id) do nothing;

create policy recipe_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'recipe-photos' and public.is_book_member(((storage.foldername(name))[1])::uuid));
create policy recipe_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'recipe-photos' and public.is_book_member(((storage.foldername(name))[1])::uuid));
create policy recipe_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'recipe-photos' and public.is_book_member(((storage.foldername(name))[1])::uuid));
create policy recipe_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'recipe-photos' and public.is_book_member(((storage.foldername(name))[1])::uuid));

-- ---------------------------------------------------------------------------
-- Live updates: changes to these tables are pushed to the other phone
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.books, public.book_members, public.recipes, public.tags, public.recipe_tags,
  public.recipe_marks, public.cook_logs, public.shopping_items, public.meal_plan;
