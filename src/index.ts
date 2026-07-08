import { handleLabel } from "./routes/label";
import { handleContext } from "./routes/context";
import { handleNamespaces } from "./routes/namespaces";
import { handleDevSeed } from "./routes/dev-seed";
import { handlePurge } from "./routes/purge";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Cache purge is POST + authenticated; handle before the GET-only guard.
    if (pathname === "/admin/purge") {
      return handlePurge(request, env, ctx);
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "GET" },
      });
    }

    if (pathname === "/dev/seed" && env.ENVIRONMENT !== "production") {
      return handleDevSeed(request, env);
    }

    if (pathname === "/label") {
      return handleLabel(request, env);
    }

    if (pathname === "/context/labels-v1.json") {
      return handleContext(env);
    }

    if (pathname === "/namespaces") {
      return handleNamespaces(env);
    }

    const nsMatch = pathname.match(/^\/namespaces\/([^/]+)$/);
    if (nsMatch) {
      return handleNamespaces(env, nsMatch[1]);
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
