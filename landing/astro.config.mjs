import { defineConfig } from "astro/config";

// Static-output Astro site. Deployed to Vercel Hobby free tier per
// [[2026-04-26-surface-architecture-landing-page]]. Zero JS by default.
export default defineConfig({
  output: "static",
});
