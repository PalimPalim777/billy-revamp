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

## Manual full-fidelity restore into throwaway Supabase — DEFERRED

Status: deferred, NOT gate-blocking. The weekly restore-drill (restore-drill.yml) already proves
pull-from-B2 -> age-decrypt -> pg_restore into Postgres 17 -> row-count gate -> canary memo decrypts
to real plaintext. That is sufficient durability proof for single-user (operator) dogfood.

This manual procedure additionally exercises Supabase-specific objects (RLS policies reattaching, the
live app reading restored data) that a bare-Postgres restore does not. Its marginal value is narrow
because the nightly dump is `--schema=public` only: the auth schema, Supabase-managed roles, and
extensions are NOT in the backup. A freshly provisioned Supabase project recreates that scaffolding,
and the dump's public tables + RLS land on top.

WHEN TO DO THIS: before onboarding a SECOND user (before any non-operator data exists). That is when
other people's data raises the stakes enough to justify the full-fidelity rehearsal.

WHY NOT YET: requires a real terminal to paste a private key and open an outbound Postgres connection
to the scratch project. Claude Code Web cannot do it (no TTY; pg17 client install and outbound DB port
are network-blocked there). Run it on a laptop/VM/WSL you control.

KEY TO USE: the DRILL private key (already a recipient of every dump), NOT the operator key. Keeps the
offline operator key out of any new environment.

Procedure (Ubuntu / WSL):

    # 0. Tooling — pg17 client via PGDG apt repo (matches the pg17 --format=custom dump)
    sudo apt-get update && sudo apt-get install -y age awscli curl ca-certificates
    sudo install -d /usr/share/postgresql-common/pgdg
    sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
      | sudo tee /etc/apt/sources.list.d/pgdg.list
    sudo apt-get update && sudo apt-get install -y postgresql-client-17

    # 1. B2 read-only creds (paste; never commit)
    export AWS_ACCESS_KEY_ID=...        # B2 RO keyID
    export AWS_SECRET_ACCESS_KEY=...    # B2 RO appKey
    export AWS_DEFAULT_REGION=eu-central-003
    EP=https://s3.eu-central-003.backblazeb2.com
    BUCKET=billy-revamp-backups

    # 2. Fetch the latest nightly dump
    LATEST=$(aws s3 ls "s3://$BUCKET/daily/" --endpoint-url "$EP" | sort | tail -1 | awk '{print $4}')
    aws s3 cp "s3://$BUCKET/daily/$LATEST" "./$LATEST" --endpoint-url "$EP"

    # 3. Decrypt with the DRILL identity (paste key into the file, shred after)
    printf '%s\n' 'AGE-SECRET-KEY-1...' > drill-identity.txt
    age -d -i drill-identity.txt -o restore.dump "$LATEST"

    # 4. Provision a THROWAWAY project (name billy-restore-test, region eu-west-3), then restore into
    #    it via its SESSION-pooler connection string (NOT direct/IPv6, NOT transaction mode 6543):
    pg_restore --no-owner --no-acl --no-comments --clean --if-exists \
      -d "postgresql://postgres.<ref>:<PW>@aws-1-eu-west-3.pooler.supabase.com:5432/postgres?sslmode=require" \
      restore.dump

    # 5. Verify (psql or the throwaway project's Supabase SQL editor):
    #    - row counts:    select count(*) from memos;  select count(*) from users;
    #    - RLS present:   select schemaname, tablename, policyname from pg_policies where schemaname='public';
    #    - (fuller) point a local run of the app at the throwaway project, log in as drill-canary,
    #      confirm the canary memo renders DECRYPTED in the UI.

    # 6. Tear down
    shred -u drill-identity.txt 2>/dev/null || rm -f drill-identity.txt
    rm -f "$LATEST" restore.dump
    #    Delete billy-restore-test: Supabase -> Project Settings -> General -> Delete project.

Sign-off: when this passes once, record the date here. Until then, the weekly drill is the standing
durability guarantee.
