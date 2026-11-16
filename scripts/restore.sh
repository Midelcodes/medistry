#!/usr/bin/env bash
# Restores an encrypted backup made by scripts/backup.sh (docs/DEPLOYMENT.md, "Restore procedure").
#
#   scripts/restore.sh /path/medistry-<stamp>.dump.gpg
#   RESTORE_DATABASE_URL  the EMPTY database to restore into (never the live database; a ?schema=... suffix is ignored)
#
# Needs the backup custodian's GPG private key in the local keyring. Checks the .sha256 first when present.
# Afterwards run scripts/verify-restore.ts against the restored database: it checks the audit chain and prints counts.
set -euo pipefail

DUMP="${1:?usage: scripts/restore.sh <dump.gpg>}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required (an empty database, not the live one)}"
PGURL="${RESTORE_DATABASE_URL%%\?*}"

if [ -f "$DUMP.sha256" ]; then
  ( cd "$(dirname "$DUMP")" && sha256sum --check --quiet "$(basename "$DUMP").sha256" )
fi

gpg --batch --quiet --decrypt "$DUMP" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$PGURL"
echo '{"event":"restore_complete"}'
