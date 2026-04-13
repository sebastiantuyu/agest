import { createServer, type Server } from "node:http";
import { langchain } from "../../../src/adapters";
import { reactAgent } from "../lookup/agent";

const executor = langchain(reactAgent);

let server: Server;

export function startServer(port = 0): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { prompt } = JSON.parse(Buffer.concat(chunks).toString());

      const result = await executor(prompt);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: result.text,
          model: result.metadata?.model,
          usage: result.metadata?.tokens
            ? {
                input_tokens: result.metadata.tokens.input,
                output_tokens: result.metadata.tokens.output,
              }
            : undefined,
        }),
      );
    });

    server.listen(port, () => {
      const addr = server.address();
      resolve(typeof addr === "object" ? addr!.port : port);
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
