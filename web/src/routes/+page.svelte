<script lang="ts">
  const REPO_URL = "https://github.com/T4ko0522/cf-edgeNix";
  const DOCS_URL = `${REPO_URL}/blob/main/docs/setup.md`;
  const SPEC_URL = `${REPO_URL}/blob/main/docs/spec.md`;

  const nixSnippet = `{
  nix.settings = {
    extra-substituters = [
      "https://t4ko.pet"
    ];
    extra-trusted-public-keys = [
      "nix.t4ko.pet-1:0eRO18L1/5diWYWboKKPTejQGhGCHNITwELiUaX7Kps=%"
    ];
  };
}`;

  type NixTokenKind = "attribute" | "operator" | "punctuation" | "string";
  type NixToken = {
    text: string;
    kind: NixTokenKind;
  };

  const nixHighlightedLines: NixToken[][] = [
    [{ text: "{", kind: "punctuation" }],
    [
      { text: "  nix", kind: "attribute" },
      { text: ".", kind: "punctuation" },
      { text: "settings", kind: "attribute" },
      { text: " = ", kind: "operator" },
      { text: "{", kind: "punctuation" },
    ],
    [
      { text: "    extra-substituters", kind: "attribute" },
      { text: " = ", kind: "operator" },
      { text: "[", kind: "punctuation" },
    ],
    [{ text: '      "https://t4ko.pet"', kind: "string" }],
    [{ text: "    ];", kind: "punctuation" }],
    [
      { text: "    extra-trusted-public-keys", kind: "attribute" },
      { text: " = ", kind: "operator" },
      { text: "[", kind: "punctuation" },
    ],
    [
      {
        text: '      "nix.t4ko.pet-1:0eRO18L1/5diWYWboKKPTejQGhGCHNITwELiUaX7Kps=%"',
        kind: "string",
      },
    ],
    [{ text: "    ];", kind: "punctuation" }],
    [{ text: "  };", kind: "punctuation" }],
    [{ text: "}", kind: "punctuation" }],
  ];

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(nixSnippet);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1600);
    } catch {
      // ignore — clipboard may be unavailable
    }
  }

  const features = [
    {
      title: "Edge-first reads",
      body: "narinfo は memory → KV → R2、NAR 本体は Cache API → R2。D1 は read path に一切乗らない。",
    },
    {
      title: "Signed & verifiable",
      body: "Ed25519 で署名された .narinfo と zstd 圧縮の NAR を /nar/<hash>.nar.zst で配信。",
    },
    {
      title: "Free-tier safe",
      body: "5 分 cron で R2 / Class A / Class B を監視。80% で warn、95% で 503 を返す kill-switch。",
    },
    {
      title: "Three-phase publish",
      body: "start → ingest × N → finalize。NAR が narinfo に先行し、D1 commit が KV warming に先行する。",
    },
  ];
</script>

<div class="relative min-h-screen overflow-x-hidden">
  <!-- Background layers -->
  <div class="pointer-events-none absolute inset-0 hero-grad"></div>
  <div class="pointer-events-none absolute inset-x-0 top-0 h-[640px] grid-overlay opacity-40"></div>

  <!-- Header -->
  <header
    class="sticky top-0 z-40 border-b border-border/60 bg-bg/70 backdrop-blur-xl backdrop-saturate-150"
  >
    <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
      <a href="/" class="brand-wordmark text-lg">
        <span class="brand-cf-edge">cf-edge</span><span class="brand-nix">Nix</span>
      </a>

      <nav class="flex items-center gap-1 text-sm text-fg-muted">
        <a
          href={DOCS_URL}
          class="rounded-md px-3 py-1.5 hover:bg-bg-elev hover:text-fg transition-colors"
          >Docs</a
        >
        <a
          href={SPEC_URL}
          class="rounded-md px-3 py-1.5 hover:bg-bg-elev hover:text-fg transition-colors"
          >Spec</a
        >
        <a
          href={REPO_URL}
          class="ml-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elev px-3 py-1.5 text-fg hover:border-border-strong transition-colors"
        >
          <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
          GitHub
        </a>
      </nav>
    </div>
  </header>

  <!-- Hero -->
  <section class="relative">
    <div class="mx-auto max-w-6xl px-6 pt-24 pb-20 md:pt-32 md:pb-28">
      <div class="mx-auto flex max-w-3xl flex-col items-center text-center">
        <h1 class="sr-only">cf-edgeNix</h1>
        <img
          src="/cf-edgeNix.png"
          alt="cf-edgeNix"
          class="mt-4 h-52 w-auto select-none md:h-80"
          draggable="false"
        />

        <p class="mx-auto mt-8 max-w-2xl text-pretty text-base text-fg-muted md:text-lg">
          R2 が正本、KV と Cache API が速度層。Workers の Free Tier だけで動く、グローバル分散の
          Nix binary cache。5 分 cron が請求前に kill-switch を引きます。
        </p>

        <div class="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            href={DOCS_URL}
            class="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-black shadow-[0_8px_24px_-8px] shadow-brand/70 hover:bg-brand-soft transition-colors"
          >
            Get started
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </a>
          <a
            href={REPO_URL}
            class="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-elev px-5 py-2.5 text-sm font-medium text-fg hover:border-border-strong transition-colors"
          >
            View on GitHub
          </a>
        </div>
      </div>

      <!-- Code preview -->
      <div class="mx-auto mt-16 max-w-2xl">
        <div
          class="overflow-hidden rounded-xl border border-border bg-bg-elev/80 shadow-2xl shadow-black/40 backdrop-blur"
        >
          <div
            class="flex items-center justify-between border-b border-border px-4 py-2.5 text-xs text-fg-muted"
          >
            <div class="flex items-center gap-2">
              <span class="h-2.5 w-2.5 rounded-full bg-[#ff5f57]"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-[#febc2e]"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-[#28c840]"></span>
              <span class="ml-3 font-mono">configuration.nix</span>
            </div>
            <button
              type="button"
              onclick={copySnippet}
              class="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted hover:text-fg hover:border-border-strong transition-colors"
              aria-live="polite"
            >
              {#if copied}
                <svg viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
                  <path d="M3 8.5l3.5 3.5L13 5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                Copied
              {:else}
                <svg viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="4" y="4" width="8" height="9" rx="1.4" />
                  <path d="M6 4V2.6c0-.33.27-.6.6-.6h6.8c.33 0 .6.27.6.6v8.8c0 .33-.27.6-.6.6H12" />
                </svg>
                Copy
              {/if}
            </button>
          </div>
          <pre
            class="overflow-x-auto px-5 py-4 text-[13px] leading-relaxed font-mono"
          ><code>{#each nixHighlightedLines as line, lineIndex}{#each line as token}<span class={`syntax-${token.kind}`}>{token.text}</span>{/each}{#if lineIndex < nixHighlightedLines.length - 1}{"\n"}{/if}{/each}</code></pre>
        </div>
        <p class="mt-3 text-center text-xs text-fg-muted">
          <code class="font-mono">nixos-rebuild switch</code> でそのまま substituter として利用できます。
        </p>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section class="relative border-t border-border/60">
    <div class="mx-auto max-w-6xl px-6 py-20 md:py-24">
      <div class="mx-auto max-w-2xl text-center">
        <h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
          Edge で完結する read path。
        </h2>
        <p class="mt-4 text-fg-muted">
          高速で安く、署名で安全。Cloudflare の primitives を素直に組んだだけのアーキテクチャです。
        </p>
      </div>

      <div class="mt-14 grid gap-4 md:grid-cols-2">
        {#each features as f}
          <div
            class="group relative overflow-hidden rounded-xl border border-border bg-bg-elev/60 p-6 transition-colors hover:border-border-strong"
          >
            <div
              class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
            ></div>
            <h3 class="text-base font-semibold tracking-tight">{f.title}</h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">{f.body}</p>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Architecture strip -->
  <section class="relative border-t border-border/60">
    <div class="mx-auto max-w-6xl px-6 py-20">
      <div class="grid items-start gap-10 md:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 class="text-2xl font-semibold tracking-tight md:text-3xl">
            3 tier lookup, 1 source of truth.
          </h2>
          <p class="mt-4 text-sm leading-relaxed text-fg-muted">
            narinfo の読みは memory（L0 isolate）→ KV（L1）→ R2（正本）の順。
            KV は結果整合、R2 が常に正本です。404 はそのまま client に伝播し、次の substituter に
            fall-through します。
          </p>
          <a
            href={SPEC_URL}
            class="mt-6 inline-flex items-center gap-1.5 text-sm text-fg hover:text-brand transition-colors"
          >
            Read the spec
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </a>
        </div>

        <div
          class="overflow-hidden rounded-xl border border-border bg-bg-elev/60 p-6 font-mono text-[13px] leading-relaxed text-fg-muted"
        >
          <div class="flex items-center gap-3">
            <span class="rounded-md border border-border bg-bg px-2 py-1 text-fg">Nix client</span>
            <span class="text-fg-muted/50">─▶</span>
            <span class="rounded-md border border-border bg-bg px-2 py-1 text-fg">Worker</span>
          </div>
          <div class="ml-[5.25rem] mt-3 space-y-2 border-l border-border pl-4">
            <div class="flex items-center gap-2">
              <span class="text-fg-muted/50">└▶</span>
              <span class="rounded-md border border-border bg-bg px-2 py-1">memory <span class="text-fg-muted/70">(L0)</span></span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-fg-muted/50">└▶</span>
              <span class="rounded-md border border-border bg-bg px-2 py-1">KV <span class="text-fg-muted/70">META_KV</span></span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-fg-muted/50">└▶</span>
              <span class="rounded-md border border-border bg-bg px-2 py-1">R2 <span class="text-fg-muted/70">NAR_BUCKET</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="relative border-t border-border/60">
    <div
      class="mx-auto flex max-w-6xl flex-col items-start gap-4 px-6 py-10 text-sm text-fg-muted md:flex-row md:items-center md:justify-between"
    >
      <div class="flex items-center gap-2">
        <span class="brand-wordmark">
          <span class="brand-cf-edge">cf-edge</span><span class="brand-nix">Nix</span>
        </span>
        <span class="text-fg-muted/60">·</span>
        <span>Built on Cloudflare Workers.</span>
      </div>
      <div class="flex items-center gap-4">
        <a href={DOCS_URL} class="hover:text-fg transition-colors">Setup</a>
        <a href={`${REPO_URL}/blob/main/docs/publish.md`} class="hover:text-fg transition-colors"
          >Publish</a
        >
        <a href={`${REPO_URL}/blob/main/docs/api.md`} class="hover:text-fg transition-colors"
          >API</a
        >
        <a href={REPO_URL} class="hover:text-fg transition-colors">GitHub</a>
      </div>
    </div>
  </footer>
</div>

<style>
  .syntax-attribute {
    color: #93c5fd;
  }

  .syntax-operator {
    color: #f8fafc;
  }

  .syntax-punctuation {
    color: #cbd5e1;
  }

  .syntax-string {
    color: #86efac;
  }
</style>
