import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

// Project page served at https://sebastiantuyu.github.io/agest/
export default defineConfig({
  site: "https://sebastiantuyu.github.io",
  base: "/agest",
  trailingSlash: "ignore",
  integrations: [tailwind()],
});
