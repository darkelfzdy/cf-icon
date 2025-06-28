
import resize from '@jsquash/resize';
// @ts-ignore
import wasmModule from '../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';

let wasmReady = WebAssembly.instantiate(wasmModule);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }

    // Automatically add https:// if no protocol is present
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    try {
      // Ensure wasm is ready before processing
      await wasmReady;

      const iconUrl = await findFavicon(targetUrl);
      const iconResponse = await fetch(iconUrl);
      const iconBuffer = await iconResponse.arrayBuffer();
      const contentType = iconResponse.headers.get('Content-Type') || 'image/png';

      let finalIconBuffer = iconBuffer;
      let finalContentType = contentType;

      // Try to resize, but fallback to original if it fails (e.g., for .ico files)
      try {
        finalIconBuffer = await resize(iconBuffer, { width: 64, height: 64 });
        finalContentType = 'image/png'; // Resize operation outputs PNG
      } catch (resizeError) {
        console.error(`Could not resize icon from ${iconUrl}, serving original. Error: ${resizeError}`);
      }
      
      return new Response(finalIconBuffer, {
        headers: {
          'Content-Type': finalContentType,
          'Cache-Control': 'public, max-age=86400', // Cache for 1 day
        },
      });
    } catch (error) {
      console.error(error);
      return new Response(`Could not find favicon for ${targetUrl}. Error: ${error}`, { status: 404 });
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
