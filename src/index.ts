
import resize, { initResize } from '@jsquash/resize';

// This is the binding to the wasm module in wrangler.toml
declare const WASM_MODULE: ArrayBuffer;

// Initialize the wasm module
initResize(WASM_MODULE);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }

    try {
      const iconUrl = await findFavicon(targetUrl);
      const iconBuffer = await fetch(iconUrl).then((res) => res.arrayBuffer());
      const resizedIcon = await resize(iconBuffer, { width: 64, height: 64 });
      
      return new Response(resizedIcon, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400', // Cache for 1 day
        },
      });
    } catch (error) {
      console.error(error);
      return new Response('Could not find favicon', { status: 404 });
    }
  },
};

async function findFavicon(url: string): Promise<string> {
  const targetUrl = new URL(url);

  // 1. Try favicon.ico
  try {
    const faviconUrl = new URL('/favicon.ico', targetUrl);
    const res = await fetch(faviconUrl.toString(), { method: 'HEAD' });
    if (res.ok) {
      return faviconUrl.toString();
    }
  } catch (e) {
    // ignore
  }

  // 2. Parse HTML for <link rel="icon">
  const res = await fetch(targetUrl.toString());
  const html = await res.text();

  let iconUrl: string | null = null;

  class IconFinder {
    element(element: Element) {
      const rel = element.getAttribute('rel');
      if (rel && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
        const href = element.getAttribute('href');
        if (href) {
          iconUrl = new URL(href, targetUrl).toString();
        }
      }
    }
  }

  await new HTMLRewriter().on('link', new IconFinder()).transform(new Response(html)).text();

  if (iconUrl) {
    return iconUrl;
  }

  throw new Error('Favicon not found');
}

interface Env {}
