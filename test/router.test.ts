import { describe, expect, test } from "vitest";
import { route } from "../src/router";

describe("route", () => {
  test("nix-cache-info", () => {
    expect(route("/nix-cache-info")).toEqual({ kind: "cache-info" });
  });

  test("narinfo はトップレベルの <hash>.narinfo にマッチ", () => {
    expect(route("/abcd1234.narinfo")).toEqual({
      kind: "narinfo",
      storeHash: "abcd1234",
    });
  });

  test("narinfo はサブパスにマッチしない", () => {
    expect(route("/foo/abcd1234.narinfo")).toEqual({ kind: "not-found" });
  });

  test("nar はファイル名を取り出す（base32 hash + .nar.zst）", () => {
    expect(route("/nar/0abcdefghijklmnopqrstuvwxyz0abcdef.nar.zst")).toEqual({
      kind: "nar",
      fileName: "0abcdefghijklmnopqrstuvwxyz0abcdef.nar.zst",
    });
  });

  test("nar: .nar.xz も許可", () => {
    expect(route("/nar/abc0def1.nar.xz")).toEqual({ kind: "nar", fileName: "abc0def1.nar.xz" });
  });

  test("nar: .nar のみ（圧縮拡張子なし）も許可", () => {
    expect(route("/nar/abc0def1.nar")).toEqual({ kind: "nar", fileName: "abc0def1.nar" });
  });

  test("nar: 大文字を含むファイル名は not-found（allowlist 違反）", () => {
    expect(route("/nar/ABC0DEF.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: .. を含むファイル名は not-found", () => {
    expect(route("/nar/../secret.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: .. をファイル名先頭に含む場合も not-found（path traversal 防止）", () => {
    expect(route("/nar/../secret")).toEqual({ kind: "not-found" });
  });

  test("nar 配下のさらにサブパスは not-found", () => {
    expect(route("/nar/a/b.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("/api/* は not-found（index.ts で hono に委譲するためルーターでは扱わない）", () => {
    expect(route("/api/hosts/myhost/latest")).toEqual({ kind: "not-found" });
  });

  test("未知パスは not-found", () => {
    expect(route("/")).toEqual({ kind: "not-found" });
    expect(route("/random")).toEqual({ kind: "not-found" });
  });

  // ─── NAR filename allowlist 拡張（Round F）───────────────────────────────────

  test("nar: .txt 拡張子は not-found（allowlist 違反）", () => {
    expect(route("/nar/foo.txt")).toEqual({ kind: "not-found" });
  });

  test("nar: 制御文字を含むファイル名は not-found", () => {
    // ヌル文字 (%00) を含むパスはデコード後にファイル名として使えない
    expect(route("/nar/abc\x00def.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: %2e%2e（URLエンコードした ..）を含む場合は not-found", () => {
    // URL パスとして渡されるため、デコード前の文字列では . が %2e になっている。
    // route() は pathname（デコード済み）を受け取るので %2e は . に変換済み。
    // スラッシュを含む場合はサブパスとして not-found になる。
    expect(route("/nar/%2e%2e/secret.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: .nar.zst 形式の正当なファイル名は通る", () => {
    expect(route("/nar/0abcdefghijklmnopqrstuvwxyz012345.nar.zst")).toEqual({
      kind: "nar",
      fileName: "0abcdefghijklmnopqrstuvwxyz012345.nar.zst",
    });
  });

  test("nar: .nar.xz 形式の正当なファイル名は通る", () => {
    expect(route("/nar/0abcdefghijklmnopqrstuvwxyz012345.nar.xz")).toEqual({
      kind: "nar",
      fileName: "0abcdefghijklmnopqrstuvwxyz012345.nar.xz",
    });
  });

  test("nar: ハイフンを含むファイル名は not-found（allowlist は [0-9a-z] のみ）", () => {
    expect(route("/nar/abc-def.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: スペースを含むファイル名は not-found", () => {
    expect(route("/nar/abc def.nar.zst")).toEqual({ kind: "not-found" });
  });

  test("nar: 空のファイル名（/nar/ で終わる）は not-found", () => {
    expect(route("/nar/")).toEqual({ kind: "not-found" });
  });
});
