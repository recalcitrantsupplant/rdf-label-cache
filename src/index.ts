import { handleLabel } from "./routes/label";
import { handleContext } from "./routes/context";
import { handleNamespaces } from "./routes/namespaces";
import { handleDevSeed } from "./routes/dev-seed";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "GET" },
      });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/dev/seed" && env.ENVIRONMENT !== "production") {
      return handleDevSeed(env);
    }

    if (pathname === "/label") {
      return handleLabel(request, env, ctx);
    }

    if (pathname === "/context/labels-v1.json") {
      return handleContext(request, env, ctx);
    }

    if (pathname === "/namespaces") {
      return handleNamespaces(request, env, ctx);
    }

    const nsMatch = pathname.match(/^\/namespaces\/([^/]+)$/);
    if (nsMatch) {
      return handleNamespaces(request, env, ctx, nsMatch[1]);
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
