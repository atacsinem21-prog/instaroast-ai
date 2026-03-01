create table if not exists roast_cases (
  id text primary key,
  slug text unique not null,
  slug_label text not null,
  title text not null,
  roast text not null,
  flex_score int not null,
  created_at timestamptz not null default now()
);

create index if not exists roast_cases_created_at_idx on roast_cases (created_at desc);
create index if not exists roast_cases_flex_score_idx on roast_cases (flex_score desc);

