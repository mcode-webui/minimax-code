import { WebuiButtonLink } from "../ui/button.js";
export function NotFound() { return <section className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-spacing_8 p-spacing_24 text-center"><h1 className="text-5xl font-semibold">404</h1><p className="text-text_default_secondary">This page could not be found.</p><WebuiButtonLink variant="grouped" size="pill" href="/archon">Return to Archon</WebuiButtonLink></section>; }

