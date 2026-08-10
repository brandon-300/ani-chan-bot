#!/data/data/com.termux/files/usr/bin/bash
# organize_backups.sh — consolidates stray backup files scattered around the
# project into backups/, renaming each to <original-name>.<mtime-epoch>.bak
# so it matches the naming convention backups/ already uses everywhere else
# (e.g. admin.js.1785395218.bak) and never collides with what's already
# there.
#
# Usage:
#   cd ~/whatsapp-bot/ani-chan-bot
#   bash organize_backups.sh          # dry run — shows what WOULD move
#   bash organize_backups.sh --apply  # actually moves the files
#
# Safe to run repeatedly: anything already inside backups/, node_modules/,
# or .git/ is skipped, and it will never overwrite an existing file — if a
# computed destination name somehow already exists, that file is skipped
# and reported instead of clobbered.

set -euo pipefail

PROJECT_ROOT="$(pwd)"
BACKUP_DIR="$PROJECT_ROOT/backups"
APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ No backups/ folder found at $BACKUP_DIR — run this from your project root."
  exit 1
fi

# Find backup-pattern files anywhere under the project, excluding the
# backups/ folder itself, node_modules, and .git.
mapfile -d '' -t FOUND < <(find "$PROJECT_ROOT" -type f \( \
    -iname "*.bak" -o -iname "*.backup" -o -iname "*.orig" -o \
    -iname "*.old" -o -iname "*~" -o -iname "*.save" \
  \) \
  ! -path "$BACKUP_DIR/*" \
  ! -path "$PROJECT_ROOT/node_modules/*" \
  ! -path "$PROJECT_ROOT/.git/*" \
  -print0)

if [ "${#FOUND[@]}" -eq 0 ]; then
  echo "✅ Nothing to do — no stray backup files found outside backups/."
  exit 0
fi

moved=0
skipped=0

echo "Found ${#FOUND[@]} stray backup file(s):"
echo ""

for f in "${FOUND[@]}"; do
  base="$(basename "$f")"
  # GNU stat (Termux ships coreutils, not BSD stat) — mtime as epoch seconds,
  # so the new name still carries when the backup was actually made instead
  # of collapsing everything to today's date.
  mtime="$(stat -c %Y "$f")"
  dest="$BACKUP_DIR/${base}.${mtime}.bak"
  rel="${f#"$PROJECT_ROOT"/}"

  if [ -e "$dest" ]; then
    echo "⚠️  SKIP (destination already exists): $rel -> backups/$(basename "$dest")"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$APPLY" = true ]; then
    mv "$f" "$dest"
    echo "✅ Moved: $rel -> backups/$(basename "$dest")"
  else
    echo "would move: $rel -> backups/$(basename "$dest")"
  fi
  moved=$((moved + 1))
done

echo ""
if [ "$APPLY" = true ]; then
  echo "✅ Done. Moved $moved file(s), skipped $skipped."
else
  echo "🔍 Dry run only — nothing was moved. Re-run with --apply to actually move these $moved file(s)."
fi
