#!/usr/bin/env sh
set -eu

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
CURRENT_SHELL="${SHELL:-unknown}"
AUTO_INSTALL="$(printf "%s" "${SECRETS_GUARD_AUTO_INSTALL:-true}" | tr '[:upper:]' '[:lower:]')"

echo "Detected OS: ${OS_NAME}"
echo "Detected shell: ${CURRENT_SHELL}"
echo "Auto-install mode: ${AUTO_INSTALL}"

have() {
  command -v "$1" >/dev/null 2>&1
}

install_pkg() {
  pkg="$1"
  apt_pkg="$2"

  if [ "${AUTO_INSTALL}" = "false" ]; then
    return 1
  fi

  if have brew; then
    if ! brew list "${pkg}" >/dev/null 2>&1; then
      brew install "${pkg}"
    fi
    return 0
  fi

  if have apt-get; then
    if have sudo; then
      sudo apt-get update
      sudo apt-get install -y "${apt_pkg}"
    else
      apt-get update
      apt-get install -y "${apt_pkg}"
    fi
    return 0
  fi

  return 1
}

missing=0

if ! have git; then
  echo "Missing dependency: git" >&2
  echo "Install Git first, then re-run this script." >&2
  missing=1
fi

if ! have python3; then
  echo "python3 not found. Attempting install..." >&2
  if ! install_pkg python python3; then
    echo "Unable to auto-install python3 on this machine." >&2
    echo "- macOS: brew install python" >&2
    echo "- Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y python3" >&2
  fi
fi

if ! have sops; then
  echo "sops not found. Attempting install..." >&2
  if ! install_pkg sops sops; then
    echo "Unable to auto-install sops on this machine." >&2
    echo "- macOS: brew install sops" >&2
    echo "- Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y sops" >&2
    echo "- Official docs: https://github.com/getsops/sops#install" >&2
  fi
fi

if ! have vercel && have npm; then
  echo "vercel CLI not found. Installing via npm..." >&2
  npm install --global vercel@latest
fi

if ! have python3; then
  echo "python3 is still missing after install attempt." >&2
  missing=1
fi

if ! have sops; then
  echo "sops is still missing after install attempt." >&2
  missing=1
fi

if [ "${missing}" -ne 0 ]; then
  echo "Dependency setup incomplete. See docs: https://github.com/internalsphere/internal-app-orchestrator#environment-variables" >&2
  exit 1
fi

echo "Secrets tooling dependencies are installed."
