#!/bin/sh
# Installs github-agent into a Debian-based image that already has bun.
# Usage in a repo's .agentkit/Dockerfile:
#   RUN curl -fsSL https://raw.githubusercontent.com/djgrant/agentkit/<ref>/github-agent/install.sh | sh -s <ref>
#   CMD ["github-agent"]
# Set GITHUB_AGENT_SOURCE to a local github-agent directory to install from it instead.
set -eu

ref=${1:-main}
command -v bun > /dev/null || { echo "github-agent needs bun on PATH" >&2; exit 1; }

# git, flock/setpriv (util-linux), and gh from GitHub's apt repo.
apt-get update -q
apt-get install -qy --no-install-recommends ca-certificates curl git util-linux
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

# Claude's defaults for every user. HOME is on the volume, which isn't there at build time.
mkdir -p /etc/claude-code
cat > /etc/claude-code/managed-settings.json <<'EOF'
{
  "model": "claude-opus-5-5",
  "attribution": { "commit": "", "pr": "" }
}
EOF

# The agent itself.
rm -rf /opt/github-agent
if [ -n "${GITHUB_AGENT_SOURCE:-}" ]; then
  cp -R "$GITHUB_AGENT_SOURCE" /opt/github-agent
else
  mkdir -p /opt/agentkit
  curl -fsSL "https://codeload.github.com/djgrant/agentkit/tar.gz/$ref" \
    | tar -xz --strip-components=1 -C /opt/agentkit --wildcards '*/github-agent/*'
  mv /opt/agentkit/github-agent /opt/github-agent
  rm -rf /opt/agentkit
fi
chmod 755 /opt/github-agent/bin/github-agent
ln -sf /opt/github-agent/bin/github-agent /usr/local/bin/github-agent

id agent > /dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
