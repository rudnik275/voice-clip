#!/usr/bin/env bash
# AI-safe secret runner. Pulls values from 1Password at exec time, never
# writes them to disk, and `op run` masks them in stdout/stderr by default.
#
# Usage:
#   ./scripts/with-secrets.sh <command> [args...]
#   ./scripts/with-secrets.sh -e .env.parser.1password <command> [args...]
#   ./scripts/with-secrets.sh bun run db:migrate
#
# AI policy (CLAUDE.md): AI may invoke this wrapper, but never `op read`,
# `op item get`, `op inject`, or commands that echo $SECRET. Rotation
# itself is human-only — see project_key_rotation.md.
set -euo pipefail

ENV_FILE=.env.1password

# Optional `-e <file>` (or `--env-file <file>`) selects a different template.
# Must come before the command.
case "${1:-}" in
  -e|--env-file)
    if [ "$#" -lt 3 ]; then
      echo "usage: $0 [-e <env-file>] <command> [args...]" >&2
      exit 1
    fi
    ENV_FILE="$2"
    shift 2
    ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found in $(pwd)" >&2
  echo "       run from repo root, or pass -e <path> to a different template." >&2
  exit 1
fi

if ! command -v op >/dev/null 2>&1; then
  echo "error: 1Password CLI 'op' not installed." >&2
  echo "       install: brew install 1password-cli (macOS) or see developer.1password.com/docs/cli" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 [-e <env-file>] <command> [args...]" >&2
  exit 1
fi

exec op run --env-file="$ENV_FILE" -- "$@"
