#!/usr/bin/env bash
# Daily encrypted PostgreSQL backup (docs/DEPLOYMENT.md, "Backups").
#
#   DATABASE_URL          the database to back up (a ?schema=... suffix is ignored)
#   BACKUP_DIR            where encrypted dumps go (keep it in-country, on storage separate from the database)
#   BACKUP_GPG_RECIPIENT  GPG public key (email or fingerprint) the dump is encrypted to. Only the public key is
#                         needed on this machine; the private key lives offline with the backup custodian.
#   BACKUP_KEEP_DAYS      delete dumps older than this (default 14)
#
# Writes medistry-<UTC timestamp>.dump.gpg (pg_dump custom format, then GPG-encrypted) and a .sha256 next to it.
# The plaintext dump never touches the disk: pg_dump streams straight into gpg.
# Schedule daily, for example with cron:  15 2 * * *  /app/scripts/backup.sh >> /var/log/medistry-backup.log 2>&1
set -euo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT is required}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PGURL="${DATABASE_URL%%\?*}" # libpq does not accept Prisma's ?schema= parameter

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/medistry-$STAMP.dump.gpg"
TMP="$OUT.partial"

pg_dump --format=custom --no-owner --no-privileges "$PGURL" \
  | gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$TMP"
mv "$TMP" "$OUT"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

find "$BACKUP_DIR" -name 'medistry-*.dump.gpg*' -type f -mtime +"$KEEP_DAYS" -delete

# No connection string or data in the log: the file name and size only.
echo "{\"event\":\"backup_written\",\"file\":\"$(basename "$OUT")\",\"bytes\":$(stat -c %s "$OUT" 2>/dev/null || wc -c < "$OUT")}"
