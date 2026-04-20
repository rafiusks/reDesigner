/**
 * Deterministic id derivation — spec §5.2.
 *
 * Input: `{componentName, filePath, lineRange, siblingIndex}`.
 * Output: a string matching `SELECTION_ID_RE` (`/^[A-Za-z0-9_-]{1,128}$/`).
 *
 * Properties:
 *   - Pure function of its inputs; no timestamp, no Date.now, no randomness.
 *   - Synchronous (called during a pick commit, not in an async IO path).
 *   - Collision-resistant enough for the selection-history scale (<1e3 entries)
 *     without requiring a cryptographic hash.
 *
 * Implementation: FNV-1a-64 computed twice over two distinct seeds to produce
 * a 16-byte digest, then base64url-encoded (22 chars, no padding). Base64url's
 * alphabet `[A-Za-z0-9_-]` is a subset of `SELECTION_ID_RE`'s charset, so the
 * output satisfies the regex by construction. Length is fixed and well below
 * 128 — no truncation required.
 *
 * Why not SHA-256? `crypto.subtle.digest` is async and the caller needs a sync
 * id at pick-commit time. A hand-rolled SHA-256 is large and offers no benefit
 * at this scale: FNV-1a with two independent seeds yields a 128-bit effective
 * space; birthday threshold ≈ 2^64, irrelevant at selection history (~1000).
 *
 * BigInt arithmetic is used for the 64-bit multiplies. It's built into all
 * target runtimes (Node 22 / Chrome 120+) and the cost at 1 call per pick
 * commit is negligible.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x00000100000001b3n
const MASK_64 = 0xffffffffffffffffn
// Seed perturbation for the second pass so the 128-bit digest is not a
// trivial re-hash of the same input space.
const SECOND_PASS_PREFIX = 'redesigner\u0001'

interface StableIdArgs {
  readonly componentName: string
  readonly filePath: string
  readonly lineRange: readonly [number, number]
  readonly siblingIndex: number
}

export function stableId(args: StableIdArgs): string {
  // Canonical input: fields joined with \u0000 separators so no input string
  // can forge a boundary. Integer fields are coerced via `| 0` to tolerate
  // non-integer runtime inputs consistently.
  const canonical = [
    args.componentName,
    args.filePath,
    String(args.lineRange[0] | 0),
    String(args.lineRange[1] | 0),
    String(args.siblingIndex | 0),
  ].join('\u0000')

  const h1 = fnv1a64(canonical)
  const h2 = fnv1a64(SECOND_PASS_PREFIX + canonical)

  const bytes = new Uint8Array(16)
  writeU64BE(bytes, 0, h1)
  writeU64BE(bytes, 8, h2)

  return base64url(bytes)
}

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS
  const utf8 = new TextEncoder().encode(input)
  for (let i = 0; i < utf8.length; i++) {
    const byte = utf8[i] as number
    hash = (hash ^ BigInt(byte)) & MASK_64
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash
}

function writeU64BE(buf: Uint8Array, offset: number, v: bigint): void {
  // Write 8 bytes big-endian from a 64-bit unsigned BigInt.
  for (let i = 0; i < 8; i++) {
    buf[offset + 7 - i] = Number((v >> BigInt(i * 8)) & 0xffn)
  }
}

/**
 * Base64url encode WITHOUT padding. Alphabet: A-Z a-z 0-9 - _
 * Output length for 16 bytes = ceil(16 * 4 / 3) = 22 chars (last char drops
 * two bits via the 2-byte-remainder branch).
 */
function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    const b2 = bytes[i + 2] as number
    out += alphabet[b0 >>> 2]
    out += alphabet[((b0 & 0x03) << 4) | (b1 >>> 4)]
    out += alphabet[((b1 & 0x0f) << 2) | (b2 >>> 6)]
    out += alphabet[b2 & 0x3f]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const b0 = bytes[i] as number
    out += alphabet[b0 >>> 2]
    out += alphabet[(b0 & 0x03) << 4]
  } else if (rem === 2) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    out += alphabet[b0 >>> 2]
    out += alphabet[((b0 & 0x03) << 4) | (b1 >>> 4)]
    out += alphabet[(b1 & 0x0f) << 2]
  }
  return out
}
