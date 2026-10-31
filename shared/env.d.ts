// The apps' Vite builds define import.meta.env; shared code reads VITE_* strings only.
interface ImportMeta { readonly env: Record<string, string | undefined> }
