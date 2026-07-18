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
        docsRouteBasePath: ["docs", "api"],
        docsDir: ["../docs", "api-gen"],
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
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      logo: {
        alt: "lofi",
        src: "img/lofi-wordmark.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/api", label: "API", position: "left" },
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
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "diff"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
