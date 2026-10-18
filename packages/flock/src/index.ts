// File locks through flock(2), run by perl, which Debian always has
// (perl-base is essential) and macOS ships, unlike util-linux's flock(1). The
// kernel drops a lock when its holder dies, so a crash never leaves one behind.
import * as fs from "node:fs";
import * as path from "node:path";

/** Exit status when the lock is already held. */
export const BUSY = 75;

const HOLD = `use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or die "$ARGV[0]: $!"; flock($f, LOCK_EX) or die "flock: $!"; $| = 1; print "locked\\n"; 1 while <STDIN>;`;

/**
 * Takes the lock, waiting for it. A helper process holds it until `release`
 * closes its stdin, or until this process dies and stdin closes with it.
 */
export const acquire = async (file: string): Promise<() => Promise<void>> => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const proc = Bun.spawn(["perl", "-e", HOLD, file], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  if (!value || !new TextDecoder().decode(value).startsWith("locked")) {
    await proc.exited;
    throw new Error(`Couldn't lock ${file}`);
  }
  reader.releaseLock();
  return async () => {
    proc.stdin.end();
    await proc.exited;
  };
};

/**
 * An argv that takes the lock without waiting, then execs `argv` holding it.
 * It exits with BUSY if the lock is held. Killing the command frees the lock.
 * `$^F` keeps the lock's descriptor open across exec.
 */
export const lockedArgv = (file: string, argv: string[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return [
    "perl",
    "-e",
    `use Fcntl ":flock"; $^F = 1023; open(my $f, ">>", shift) or die "$!"; flock($f, LOCK_EX | LOCK_NB) or exit ${BUSY}; exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!";`,
    file,
    ...argv,
  ];
};

export const withLock = async <T>(file: string, fn: () => Promise<T>): Promise<T> => {
  const release = await acquire(file);
  try {
    return await fn();
  } finally {
    await release();
  }
};
