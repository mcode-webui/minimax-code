import { IconFolder, IconSearch } from "@tabler/icons-react";
import type { ReactElement } from "react";

export function SearchIcon(): ReactElement {
  return <IconSearch aria-hidden="true" size={18} stroke={1.5} />;
}

export function FolderIcon(): ReactElement {
  return <IconFolder aria-hidden="true" size={18} stroke={1.5} />;
}
