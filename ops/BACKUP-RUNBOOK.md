# Billy Revamp — Backup Runbook (Phase 4.1a)

Nightly pg_dump of the Supabase `public` schema, age-encrypted, stored in Backblaze B2. Runs in GitHub Actions (`.github/workflows/nightly-backup.yml`). Restore is Phase 4.1b. PRODUCING backups (4.1a) does NOT open the dogfood gate — that opens only after 4.1b proves a restore.

## What runs
- Trigger: nightly cron 02:17 UTC + manual workflow_dispatch.
- Steps: dump (`public` only, `-Fc --no-owner --no-acl`, pg17 via docker) -> age encrypt (recipient public key) -> upload to B2 over the S3 API -> success ping to healthchecks.io (failure pings the `/fail` endpoint).
- Connection: Supabase SESSION-mode pooler (port 5432), `sslmode=require`. NOT the direct/IPv6 host, NOT transaction mode (6543) — pg_dump breaks under transaction pooling.
- Dump scope is `public` only by design: Supabase-managed schemas (auth/storage/extensions) are re-created by provisioning a fresh project; the irreplaceable app data lives in `public`. `--no-owner --no-acl` keeps the dump restorable into bare Postgres or a fresh project.

## Secrets (GitHub -> Settings -> Secrets and variables -> Actions)
- `SUPABASE_DB_URL` — session-pooler URI incl. password and `?sslmode=require`
- `B2_KEY_ID`, `B2_APP_KEY` — B2 application key scoped to ONLY the backup bucket, Write Only preset (fallback: Read and Write if the upload 403s). Write-only means a leaked job key cannot read or delete existing dumps.
- `AGE_PUBLIC_KEY` — age recipient public key (`age1...`). The private identity lives ONLY in the operator's password manager.
- `HEALTHCHECK_URL` — healthchecks.io ping URL.

## Non-secret config (workflow `env:` block)
- `B2_BUCKET`, `B2_S3_ENDPOINT` (`https://s3.<region>.backblazeb2.com`), `AWS_DEFAULT_REGION` (B2 region).

## Bucket
- Private, SSE-B2 (default encryption) ON.
- Lifecycle rule, prefix `daily/`: daysFromUploadingToHiding=30, daysFromHidingToDeleting=1 (~30-day retention).
- Region eu-central-003 (EU residency, matches the project posture).

## Key custody (operator-critical)
- The age PRIVATE identity is the only thing that can decrypt backups. Store it in your password manager; if lost, every backup is unrecoverable. Never commit it; never store it in B2 or GitHub.
- The runner holds only the PUBLIC key -> it can encrypt but never decrypt.

## Failure visibility
- healthchecks.io alerts if the success ping is missing — catches failures AND non-runs.
- GitHub emails the repo owner on workflow failure (secondary).
- WARNING: GitHub disables scheduled workflows after 60 days of repo inactivity. The healthcheck heartbeat is the safety net for that.

## Rotating credentials
- DB password: reset in Supabase (Settings -> Database), update `SUPABASE_DB_URL`.
- B2 key: create a new scoped key, update `B2_KEY_ID`/`B2_APP_KEY`, delete the old.
- age key: generate a new identity; new dumps use the new public key; keep the old private identity as long as old backups exist.

## Restore
- See Phase 4.1b (restore drill + canary decrypt). Until 4.1b lands, these backups are UNVERIFIED.
