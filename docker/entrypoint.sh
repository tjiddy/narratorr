#!/bin/sh
set -e

# PUID/PGID user management
# Creates a user with the specified UID/GID and runs the app as that user.
# When neither PUID nor PGID is set, runs as the default container user.

PUID="${PUID:-}"
PGID="${PGID:-}"

if [ -n "$PUID" ]; then
  # Validate PUID is a positive integer
  if ! echo "$PUID" | grep -qE '^[0-9]+$' || [ "$PUID" -eq 0 ]; then
    echo "ERROR: PUID must be a positive integer, got: $PUID" >&2
    exit 1
  fi

  # Default PGID to PUID if not set
  PGID="${PGID:-$PUID}"

  # Validate PGID
  if ! echo "$PGID" | grep -qE '^[0-9]+$' || [ "$PGID" -eq 0 ]; then
    echo "ERROR: PGID must be a positive integer, got: $PGID" >&2
    exit 1
  fi

  echo "Setting up user with PUID=$PUID PGID=$PGID"

  # Create group if it doesn't exist
  if ! getent group "$PGID" > /dev/null 2>&1; then
    addgroup -g "$PGID" narratorr
  fi

  GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

  # Create user if it doesn't exist
  if ! getent passwd "$PUID" > /dev/null 2>&1; then
    adduser -D -u "$PUID" -G "$GROUP_NAME" -h /app narratorr
  fi

  USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

  # Fix ownership of data directories
  chown -R "$PUID:$PGID" /config /audiobooks /downloads

  # Run as the specified user
  exec su-exec "$USER_NAME" node dist/server/index.js
else
  # No PUID set — run as default user
  exec node dist/server/index.js
fi
