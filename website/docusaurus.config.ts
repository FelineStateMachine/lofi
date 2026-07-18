import { readFileSync } from "node:fs";
import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const denoJson = JSON.parse(
  readFileSync(new URL("../deno.json", import.meta.url), "utf8"),
) as { version: string; description: string };

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

  headTags: [
    {
      tagName: "link",
      attributes: { rel: "preconnect", href: "https://fonts.googleapis.com" },
    },
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "anonymous",
      },
    },
  ],
  stylesheets: [
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=Nunito:wght@800;900&family=Karla:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
  ],

  plugins: [
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
      logo: {
        alt: "lofi",
        src: "img/lofi-wordmark.svg",
        // intrinsic dimensions (800x360 viewBox at the navbar's 1.7rem height)
        // so the image never contributes layout shift
        width: 60,
        height: 27,
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/api", label: "API", position: "left" },
        { to: "/node", label: "Self-host", position: "left" },
        { href: "https://jsr.io/@nzip/lofi", label: "JSR", position: "right" },
        {
          href: "https://github.com/FelineStateMachine/lofi",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Start",
          items: [
            { label: "Getting started", to: "/docs/getting-started" },
            { label: "Data and UI", to: "/docs/data-and-ui" },
            { label: "Testing", to: "/docs/testing" },
          ],
        },
        {
          title: "Deeper",
          items: [
            { label: "Permissions", to: "/docs/permissions" },
            { label: "Sync and recovery", to: "/docs/sync-and-recovery" },
            { label: "API reference", to: "/api" },
            { label: "Self-host a sync node", to: "/node" },
          ],
        },
        {
          title: "Repo",
          items: [
            { label: "GitHub", href: "https://github.com/FelineStateMachine/lofi" },
            { label: "JSR", href: "https://jsr.io/@nzip/lofi" },
            { label: "llms.txt", to: "/llms.txt", target: "_blank" },
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
