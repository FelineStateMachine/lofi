import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
import manifest from "./docs-manifest.json";

// The sidebar is derived from docs-manifest.json so that the site navigation
// and the generated llms.txt / llms-full.txt (tools/site_llms.ts) can never
// disagree about which docs are published or in what order.

type ManifestItem = { id: string; label: string };
type ManifestSection = {
  label: string | null;
  collapsed?: boolean;
  indexId?: string;
  items: ManifestItem[];
  extraLinks?: { label: string; href: string }[];
};

type SidebarItem =
  | { type: "doc"; id: string; label: string }
  | { type: "link"; label: string; href: string }
  | {
    type: "category";
    label: string;
    collapsed: boolean;
    link?: { type: "doc"; id: string };
    items: SidebarItem[];
  };

const docsSidebar: SidebarItem[] = (manifest.sections as ManifestSection[]).flatMap(
  (section) => {
    const items: SidebarItem[] = [
      ...section.items.map((item) => ({
        type: "doc" as const,
        id: item.id,
        label: item.label,
      })),
      ...(section.extraLinks ?? []).map((link) => ({
        type: "link" as const,
        label: link.label,
        href: link.href,
      })),
    ];
    if (section.label === null) return items;
    return [{
      type: "category" as const,
      label: section.label,
      collapsed: section.collapsed ?? true,
      ...(section.indexId ? { link: { type: "doc" as const, id: section.indexId } } : {}),
      items,
    }];
  },
);

const sidebars: SidebarsConfig = { docs: docsSidebar };

export default sidebars;
