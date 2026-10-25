#!/bin/sh
# Installs achq-agent into a Debian-based image that already has bun.
# Usage in a repo's .achq/Dockerfile:
#   ARG ACHQ_REF=main
#   RUN curl -fsSL "https://raw.githubusercontent.com/djgrant/achq/$ACHQ_REF/install.sh" | sh -s "$ACHQ_REF"
# No CMD: the container provider starts the runner itself.
# Set ACHQ_SOURCE to a local achq checkout to install from it instead.
set -eu

ref=${1:-main}
command -v bun > /dev/null || { echo "achq-agent needs bun on PATH" >&2; exit 1; }

# perl runs the thread locks, and Debian always has perl-base. setpriv comes
# from util-linux. gh comes from GitHub's apt repo.
apt-get update -q
apt-get install -qy --no-install-recommends ca-certificates curl git perl-base tar util-linux
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -q
apt-get install -qy --no-install-recommends gh
rm -rf /var/lib/apt/lists/*

# Claude Code's native build, copied out of the installer's home so it doesn't
# depend on any user's HOME.
tmp=$(mktemp -d)
curl -fsSL https://claude.ai/install.sh | HOME="$tmp" bash
install -m 755 "$(readlink -f "$tmp/.local/bin/claude")" /usr/local/bin/claude
rm -rf "$tmp"

# The agent itself, with its workspace packages linked by `bun install`.
# Repo configs' `achq` and `achq/github` imports resolve to /opt/achq/packages/achq.
rm -rf /opt/achq
mkdir -p /opt/achq
if [ -n "${ACHQ_SOURCE:-}" ]; then
  cp -R "$ACHQ_SOURCE/packages" "$ACHQ_SOURCE/patches" "$ACHQ_SOURCE/package.json" "$ACHQ_SOURCE/bun.lock" /opt/achq
else
  curl -fsSL "https://codeload.github.com/djgrant/achq/tar.gz/$ref" \
    | tar -xz --strip-components=1 -C /opt/achq --wildcards '*/packages/*' '*/patches/*' '*/package.json' '*/bun.lock'
fi
rm -rf /opt/achq/packages/*/node_modules
(cd /opt/achq && bun install --production --frozen-lockfile)
chmod 755 /opt/achq/packages/service-container/bin/achq-agent
ln -sf /opt/achq/packages/service-container/bin/achq-agent /usr/local/bin/achq-agent

id agent > /dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
