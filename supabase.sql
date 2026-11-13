-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run

create table if not exists profiles (
  client_id      text primary key,
  is_pro         boolean not null default false,
  free_count     int     not null default 0,
  cooldown_until bigint  not null default 0,   -- unix ms
  created_at     timestamptz not null default now()
);

create table if not exists chats (
  id         text primary key,
  client_id  text not null references profiles(client_id) on delete cascade,
  title      text not null default 'New Conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_client_idx on chats (client_id, updated_at desc);

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null references chats(id) on delete cascade,
  role        text not null check (role in ('user','ai')),
  model       text,
  text        text not null,
  attachments jsonb not null default '[]',
  created_at  timestamptz not null default now()
);
create index if not exists messages_chat_idx on messages (chat_id, created_at);

-- RLS ON + koi policy nahi = browser (anon key) se koi access nahi.
-- Sirf aapka backend (service_role key) access kar sakta hai.
alter table profiles enable row level security;
alter table chats    enable row level security;
alter table messages enable row level security;
