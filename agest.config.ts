import { defineConfig } from "./src/index";

export default defineConfig({
  parallelism: 4,
  judge: {
    model: "openai/gpt-oss-120b",
  },
  turns: 3,
  timeout: 35_000
});
