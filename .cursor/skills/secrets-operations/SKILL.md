---
name: secrets-operations
description: Manage orchestrator secrets with explicit list, add, update, and delete operations. Use when the user asks to list remote or local secret keys, add a new encrypted secret, rotate/update an existing secret, or remove a secret. Assumes scripts/secrets.py is available; do not print secret values.
---

# Secrets Operations

Use this skill when working with app secrets stored under:

- `secrets/shared/`
- `secrets/preview/`
- `secrets/production/`

## When to use

- List declared secrets in the repo
- List remote keys from `secrets/inventory.yaml`
- Add a new encrypted secret file
- Update an existing encrypted secret file
- Delete a secret file

## Safety rules

- Never print decrypted secret values into the chat or commit messages.
- Prefer the default hidden prompt for manual entry.
- Use `--from-stdin` for automation.
- Paste multiline values into the hidden prompt and press `Ctrl-D` once on macOS/Linux when finished.
- Do not manually edit `secrets/inventory.yaml`; CI regenerates it.
- Do not commit tracked plaintext `.env*` files except `.env.example`, `.env.sample`, or `.env.template`.

## List

1. To list local secrets, use `--scope local` and an optional `--env` filter.
2. To list remote keys, use `--scope remote` and `--env preview` or `--env production`.
3. Review the output and identify the key/path you need.

Example:

```bash
python3 scripts/secrets.py list --scope remote --env production
```

## Add

1. Choose the correct scope: `shared`, `preview`, or `production`.
2. Let the CLI prompt for the secret value without echoing it.
3. Commit the new encrypted file.

Example:

```bash
python3 scripts/secrets.py add --scope shared --key DATABASE_URL
```

## Update

1. Confirm the secret already exists in the target scope.
2. Let the CLI prompt for the new secret value without echoing it.
3. Commit the updated encrypted file.

Example:

```bash
python3 scripts/secrets.py update --scope production --key STRIPE_SECRET_KEY
```

## Delete

1. Confirm the exact scope and key.
2. Delete the encrypted file.
3. Commit the removal so CI can remove the remote app-managed key.

Example:

```bash
python3 scripts/secrets.py delete --scope preview --key NEXT_PUBLIC_API_BASE
```

## Verify

- Re-run `list` locally to confirm the file exists or is gone.
- After CI runs, check `secrets/inventory.yaml` for the remote key inventory.
- If something fails, see `references/troubleshooting.md`.
