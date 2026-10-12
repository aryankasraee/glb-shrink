const UNITS = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** Parses "1MB", "900KB", "1.5MiB" or a plain byte count. KB/MB are decimal, KiB/MiB binary. */
export function parseSize(value) {
  if (typeof value === 'number') return value;
  const m = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) throw new Error(`Invalid size: "${value}" (examples: 1MB, 900KB, 1.5MiB)`);
  const unit = UNITS[m[2] || 'b'];
  if (!unit) throw new Error(`Invalid size unit in "${value}" (use B, KB, MB, GB, KiB, MiB, GiB)`);
  return Math.round(parseFloat(m[1]) * unit);
}

export function formatBytes(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
