-- model_prices.created_at (architecture-baseline §4)

alter table model_prices
  add column if not exists created_at timestamptz not null default now();
