import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const denoJson = JSON.parse(
  readFileSync(new URL("../deno.json", import.meta.url), "utf8"),
) as { version: string; description: string };

// The /node landing shows the lofi-node version from the same pinned checkout
// the docs render from (LOFI_NODE_DIR, default ../lofi-node); "alpha" when the
// checkout is absent so a docs-only environment still builds.
let lofiNodeVersion = "alpha";
try {
  const nodeDir = process.env.LOFI_NODE_DIR ?? "../lofi-node";
  lofiNodeVersion = (JSON.parse(
    readFileSync(new URL(`../${nodeDir}/deno.json`, import.meta.url), "utf8"),
  ) as { version: string }).version;
} catch {
  // Keep the fallback label.
}

// Fonts must ship as files, not base64 in the render-blocking stylesheet —
// webpack's default inline threshold would bloat styles.css by hundreds of KB.
// Rewrites Docusaurus's own font rule in place: appending a second rule makes
// webpack run both, and the asset/resource pass emits the url-loader's JS
// module source as the .woff2 the CSS points at — a 127-byte stub, no font.
function noInlineFontsPlugin() {
  return {
    name: "lofi-no-inline-fonts",
    configureWebpack: (config: { module?: { rules?: unknown[] } }) => {
      for (const rule of config.module?.rules ?? []) {
        if (
          rule && typeof rule === "object" && "test" in rule &&
          rule.test instanceof RegExp && rule.test.test("x.woff2")
        ) {
          const fontRule = rule as Record<string, unknown>;
          delete fontRule.use;
          fontRule.type = "asset/resource";
          fontRule.generator = { filename: "assets/fonts/[name]-[hash][ext]" };
        }
      }
      return {};
    },
  };
}

const config: Config = {
  title: "lofi",
  tagline: "Put down roots. Skip the spinner.",
  favicon: "img/favicon.svg",

  future: {
    v4: true,
  },

  url: "https://lofi.host",
  baseUrl: "/",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "warn",

  customFields: {
    lofiVersion: denoJson.version,
    lofiDescription: denoJson.description,
    lofiNodeVersion,
  },

  markdown: {
    // Parse .md files as CommonMark so existing docs need no MDX escaping;
    // only .mdx files opt into MDX.
    format: "detect",
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  themes: [
    "@docusaurus/theme-mermaid",
    [
      // fully client-side search over an index built at build time — no
      // external search service, which suits a local-first framework
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: ["docs", "api", "node/docs", "node/api"],
        docsDir: ["../docs", "api-gen", "node-docs-gen", "node-api-gen"],
      },
    ],
  ],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  // Fonts are self-hosted via Fontsource imports in src/css/custom.css, so
  // the docs work offline with their real faces and no third-party requests.

  plugins: [
    noInlineFontsPlugin,
    [
      // The docs for the offline-first framework install and read offline.
      // Precaching is opt-in (installed PWA / standalone / ?offlineMode) so
      // drive-by visitors are not handed the whole corpus.
      "@docusaurus/plugin-pwa",
      {
        // trailingSlash:false emits routes as <path>.html, which the default
        // worker never checks; see src/sw-custom.js.
        swCustom: fileURLToPath(new URL("./src/sw-custom.js", import.meta.url)),
        offlineModeActivationStrategies: [
          "appInstalled",
          "standalone",
          "queryString",
        ],
        pwaHead: [
          { tagName: "link", rel: "manifest", href: "/manifest.json" },
          { tagName: "meta", name: "theme-color", content: "#18231f" },
          {
            tagName: "meta",
            name: "apple-mobile-web-app-capable",
            content: "yes",
          },
          {
            tagName: "meta",
            name: "apple-mobile-web-app-status-bar-style",
            content: "black-translucent",
          },
          {
            tagName: "link",
            rel: "apple-touch-icon",
            href: "/img/pwa/icon-192.png",
          },
        ],
      },
    ],
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "api",
        path: "api-gen",
        routeBasePath: "api",
        sidebarPath: "./sidebars-api.ts",
        editUrl: undefined,
      },
    ],
    [
      "@docusaurus/plugin-content-docs",
      {
        // Assembled by tools/node_docs.ts from docs/node/ plus contract pages
        // rendered out of the pinned lofi-node checkout; no edit URL because
        // pages have two possible homes — each page names its source.
        id: "node",
        path: "node-docs-gen",
        routeBasePath: "node/docs",
        sidebarPath: "./sidebars-node.ts",
        editUrl: undefined,
      },
    ],
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "node-api",
        path: "node-api-gen",
        routeBasePath: "node/api",
        sidebarPath: "./sidebars-node-api.ts",
        editUrl: undefined,
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          path: "../docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          // `exclude` replaces the plugin defaults, so the `_`-prefix globs
          // must be restated alongside the repo-only content.
          exclude: [
            "spikes/**",
            "devx-contract.md",
            "seed.md",
            "assets/**",
            // Served under /node/docs by the "node" plugin instance instead.
            "node/**",
            "**/_*.{js,jsx,ts,tsx,md,mdx}",
            "**/_*/**",
          ],
          editUrl: "https://github.com/FelineStateMachine/lofi/edit/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/lofi-social-card.png",
    mermaid: {
      // one custom brand palette for both color modes: filled shapes carry
      // their own text color (mint/lime with forest ink), and floating text
      // and lines use a mid sage that stays readable on light and dark pages
      theme: { light: "base", dark: "base" },
      options: {
        themeVariables: {
          fontFamily: '"Karla", system-ui, -apple-system, sans-serif',
          primaryColor: "#99e5bd",
          primaryTextColor: "#18231f",
          primaryBorderColor: "#39725c",
          secondaryColor: "#d5f26a",
          secondaryTextColor: "#18231f",
          secondaryBorderColor: "#39725c",
          tertiaryColor: "#c9eeda",
          tertiaryTextColor: "#18231f",
          tertiaryBorderColor: "#39725c",
          lineColor: "#6f9d88",
          // floating labels render on the mint edge-label chip, so they carry
          // forest ink; standalone titles use the mid sage via titleColor
          textColor: "#18231f",
          clusterBkg: "rgba(153, 229, 189, 0.16)",
          clusterBorder: "#39725c",
          titleColor: "#6f9d88",
          clusterTextColor: "#6f9d88",
          edgeLabelBackground: "#99e5bd",
          actorBkg: "#99e5bd",
          actorTextColor: "#18231f",
          actorBorder: "#39725c",
          actorLineColor: "#6f9d88",
          signalColor: "#6f9d88",
          signalTextColor: "#6f9d88",
          labelBoxBkgColor: "#d5f26a",
          labelBoxBorderColor: "#39725c",
          labelTextColor: "#18231f",
          loopTextColor: "#6f9d88",
          activationBkgColor: "#d5f26a",
          activationBorderColor: "#39725c",
          noteBkgColor: "#d5f26a",
          noteTextColor: "#18231f",
          noteBorderColor: "#39725c",
        },
      },
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      // Two trees, no wordmark: the site now fronts two products, and each
      // product's own dropdown carries its links (so no top-level GitHub/JSR).
      logo: {
        alt: "lofi",
        src: "img/two-trees.svg",
        // square intrinsic dimensions at the navbar's 1.7rem height so the
        // image never contributes layout shift
        width: 30,
        height: 30,
      },
      items: [
        {
          type: "dropdown",
          label: "lofi",
          position: "left",
          to: "/",
          items: [
            { label: "docs", to: "/docs" },
            { label: "api", to: "/api" },
            { label: "github", href: "https://github.com/FelineStateMachine/lofi" },
            { label: "jsr", href: "https://jsr.io/@nzip/lofi" },
          ],
        },
        {
          type: "dropdown",
          label: "lofi-node",
          position: "left",
          to: "/node",
          items: [
            { label: "docs", to: "/node/docs" },
            { label: "api", to: "/node/api" },
            { label: "github", href: "https://github.com/FelineStateMachine/lofi-node" },
            { label: "jsr", href: "https://jsr.io/@nzip/lofi-node" },
          ],
        },
      ],
    },
    footer: {
      style: "dark",
      // One column per product, parallel structure, lowercase like the nav.
      links: [
        {
          title: "lofi",
          items: [
            { label: "docs", to: "/docs" },
            { label: "api", to: "/api" },
            { label: "github", href: "https://github.com/FelineStateMachine/lofi" },
            { label: "jsr", href: "https://jsr.io/@nzip/lofi" },
            { label: "llms.txt", to: "/llms.txt", target: "_blank" },
          ],
        },
        {
          title: "lofi-node",
          items: [
            { label: "docs", to: "/node/docs" },
            { label: "api", to: "/node/api" },
            { label: "github", href: "https://github.com/FelineStateMachine/lofi-node" },
            { label: "jsr", href: "https://jsr.io/@nzip/lofi-node" },
            { label: "llms.txt", to: "/node/llms.txt", target: "_blank" },
          ],
        },
      ],
      copyright: `MIT licensed. Built with Docusaurus.`,
    },
    prism: {
      // gruvbox material is the standard theme closest to the brand palette:
      // olive/lime greens and mint aquas on warm dark and cream backgrounds
      theme: prismThemes.gruvboxMaterialLight,
      darkTheme: prismThemes.gruvboxMaterialDark,
      additionalLanguages: ["bash", "json", "diff"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
