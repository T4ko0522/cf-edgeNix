export type AuthResult = { ok: true } | { ok: false; status: 401 | 403 };

/**
 * ADMIN_TOKEN による Bearer 認証を検証する純粋関数。
 *
 * - adminToken が未設定（undefined / 空文字）→ { ok:false, status:403 }（安全側）
 * - Authorization ヘッダ欠落 / "Bearer " プレフィクス不正 → { ok:false, status:401 }
 * - トークン不一致 → { ok:false, status:401 }（定数時間 XOR ループ比較）
 * - 一致 → { ok:true }
 */
export function checkAdminAuth(
  req: Request,
  adminToken: string | undefined,
): AuthResult {
  if (!adminToken) return { ok: false, status: 403 };

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return { ok: false, status: 401 };

  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return { ok: false, status: 401 };

  const supplied = authHeader.slice(prefix.length);
  if (!timingSafeEqual(supplied, adminToken)) return { ok: false, status: 401 };

  return { ok: true };
}

/**
 * 長さが異なる場合も即 return しない XOR ループ比較（定数時間相当）。
 * 長さ不一致は最後に判定する。
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

// ─── 入力検証ヘルパ（スタブ） ────────────────────────────────────────────────

/** ホスト名: ASCII 英数字 / ドット / ハイフン / アンダースコアのみ */
export function validateHost(s: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(s);
}

/** build ID: [a-zA-Z0-9-] の形式（UUID を含む） */
export function validateBuildId(s: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(s);
}

/** store hash: base32 小文字英数字のみ */
export function validateStoreHash(s: string): boolean {
  return /^[0-9a-z]+$/.test(s);
}
