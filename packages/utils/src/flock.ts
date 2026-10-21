import * as fs from "node:fs";
import * as path from "node:path";

// perl rather than flock(1): Debian always has perl-base and macOS ships perl, but not util-linux.
const HOLD = `use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or die "$ARGV[0]: $!"; flock($f, LOCK_EX) or die "flock: $!"; $| = 1; print "locked\\n"; 1 while <STDIN>;`;

export const flock = {
  /** Exit status when the lock is already held. */
  BUSY: 75,

  /**
   * Takes the lock, waiting for it. A helper process holds it until `release`
   * closes its stdin, or until this process dies and stdin closes with it.
   */
  acquire: async (file: string): Promise<() => Promise<void>> => {
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
  },

  /**
   * An argv that takes the lock without waiting, then execs `argv` holding it.
   * It exits with BUSY if the lock is held. Killing the command frees the lock.
   * `$^F` keeps the lock's descriptor open across exec.
   */
  lockedArgv: (file: string, argv: string[]) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return [
      "perl",
      "-e",
      `use Fcntl ":flock"; $^F = 1023; open(my $f, ">>", shift) or die "$!"; flock($f, LOCK_EX | LOCK_NB) or exit ${flock.BUSY}; exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!";`,
      file,
      ...argv,
    ];
  },

  withLock: async <T>(file: string, fn: () => Promise<T>): Promise<T> => {
    const release = await flock.acquire(file);
    try {
      return await fn();
    } finally {
      await release();
    }
  },
};
