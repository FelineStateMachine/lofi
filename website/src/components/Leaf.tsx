import type { ReactNode } from "react";
import { useId } from "react";

/** The brand leaf glyph used as a cell marker on the landing pages. */
export default function Leaf(): ReactNode {
  const maskId = useId();
  return (
    <svg className="cell-leaf" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <mask id={maskId}>
          <rect width="512" height="512" fill="#fff" />
          <path
            d="M183 184v146h124M183 330 91 455"
            fill="none"
            stroke="#000"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="38"
          />
        </mask>
      </defs>
      <path
        d="M415 56C253 58 112 112 67 224c-32 80-21 173 24 231l47-49c57 29 135 21 197-20 52-34 80-93 80-160Z"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
