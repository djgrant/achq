#!/bin/sh
# Installs what achq-runner needs into a Debian-based image that already has
# bun, and achq-runner itself, which runs the runner from npm.
# Usage in a repo's .achq/Dockerfile:
#   RUN curl -fsSL https://raw.githubusercontent.com/djgrant/achq/main/install.sh | sh
# No CMD: the container provider starts the runner itself.
set -eu

command -v bun > /dev/null || { echo "achq-runner needs bun on PATH" >&2; exit 1; }

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

# The runner itself comes from npm when the container starts, at the version
# its deployer gives it as ACHQ_VERSION, with the plugins ACHQ_PLUGINS names
# installed under DATA_DIR. This is what's on PATH: it hands the volume to the
# `agent` user, as a platform may mount it root-owned, and runs the runner as
# that user, with Bun's cache on the volume, so a wake doesn't download it
# again. Agents such as Claude refuse to skip permission prompts as root.
cat > /usr/local/bin/achq-runner <<'RUNNER'
#!/bin/sh
set -eu
data=${DATA_DIR:-/data}
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data"
  chown agent:agent "$data"
  # The image's WORKDIR may be unreadable to `agent` (oven/bun's is /home/bun/app).
  cd "$data"
  exec setpriv --reuid=agent --regid=agent --init-groups env HOME="$data/home" "$0" "$@"
fi
: "${ACHQ_VERSION:?achq-runner needs ACHQ_VERSION, which its deployer sets}"
export BUN_INSTALL_CACHE_DIR="$data/bun-cache"
exec bunx "@achq/runner@$ACHQ_VERSION" "$@"
RUNNER
chmod 755 /usr/local/bin/achq-runner

id agent > /dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
