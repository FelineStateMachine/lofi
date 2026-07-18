import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
import manifest from "./node-docs-manifest.json";

// Mirrors sidebars.ts: the /node/docs sidebar derives from
// node-docs-manifest.json so navigation and the generated /node/llms.txt
// (tools/site_llms.ts) can never disagree about which pages are published or
// in what order. Page files themselves are assembled by tools/node_docs.ts.

type ManifestItem = { id: string; label: string; source: string };
type ManifestSection = {
  label: string | null;
  collapsed?: boolean;
  items: ManifestItem[];
};

type SidebarItem =
  | { type: "doc"; id: string; label: string }
  | {
    type: "category";
    label: string;
    collapsed: boolean;
    items: SidebarItem[];
  };

const nodeSidebar: SidebarItem[] = (manifest.sections as ManifestSection[]).flatMap(
  (section) => {
    const items: SidebarItem[] = section.items.map((item) => ({
      type: "doc" as const,
      id: item.id,
      label: item.label,
    }));
    if (section.label === null) return items;
    return [{
      type: "category" as const,
      label: section.label,
      collapsed: section.collapsed ?? true,
      items,
    }];
  },
);

const sidebars: SidebarsConfig = { node: nodeSidebar };

export default sidebars;
