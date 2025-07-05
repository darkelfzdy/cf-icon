import resize, { initResize } from '@jsquash/resize';
import { decode as pngDecode, encode as pngEncode } from '@jsquash/png';
import { init as initPng } from '@jsquash/png/decode';
import jpegDecode, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import { encode as jpegEncode, init as initJpegEncode } from '@jsquash/jpeg/encode';
// Correct imports for webp decode and encode with their respective init functions
import webpDecode, { init as initWebpDecode } from '@jsquash/webp/decode';
import { encode as webpEncode, init as initWebpEncode } from '@jsquash/webp/encode';
import decodeIco from 'decode-ico';

// Import WASM files from the local wasm directory
// These imports are typically handled by bundlers to provide ArrayBuffer or WebAssembly.Module
// For Cloudflare Workers, with `wrangler.toml` build rules, these should be available as ArrayBuffer.
import resizeWasm from '../wasm/squoosh_resize_bg.wasm';
import pngWasm from '../wasm/squoosh_png_bg.wasm';
import jpegDecWasm from '../wasm/mozjpeg_dec.wasm';
import jpegEncWasm from '../wasm/mozjpeg_enc.wasm';
import webpDecWasm from '../wasm/webp_dec.wasm';
import webpEncWasm from '../wasm/webp_enc.wasm';

// Initialize all WASM modules
// Each init function expects an ArrayBuffer.
// Assuming the `import ... from \'...wasm\'` provides an ArrayBuffer due to wrangler.toml build rules.
const wasmReady = Promise.all([
  initResize(resizeWasm),
  initPng(pngWasm),
  initJpegDecode(jpegDecWasm),
  initJpegEncode(jpegEncWasm),
  initWebpDecode(webpDecWasm),
  initWebpEncode(webpEncWasm),
]);


// Defines the structure for an icon candidate
interface IconCandidate {
  url: string;
  rel?: string | null;
  sizes?: string | null;
  type?: string | null;
  score: number;
}

// Scores a candidate icon based on its attributes to determine the best quality
function scoreCandidate(candidate: { href: string; rel: string | null; sizes: string | null; type: string | null }): number {
  let score = 0;
  const { href, rel, sizes, type } = candidate;

  // Score based on file type
  if (href.endsWith('.svg') || type === 'image/svg+xml') {
    score += 1000; // SVG is preferred
  }

  // Score based on 'rel' attribute
  if (rel?.includes('apple-touch-icon')) {
    score += 650;
  } else if (rel === 'manifest-icon') {
    score += 650;
  } else if (rel?.includes('icon')) {
    score += 100;
  }

  // Score based on 'sizes' attribute
  if (sizes) {
    if (sizes === 'any') {
      score += 500; // 'any' is often for SVGs
    } else {
      const sizeMatch = sizes.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        score += parseInt(sizeMatch[1], 10); // Use width as part of the score
      }
    }
  }
  
  // og:image is a low-priority fallback
  if (rel === 'og:image') {
      score = 50;
  }

  return score;
}

// Finds the best possible icon for a given URL
async function findBestIcon(targetUrl: URL): Promise<string> {
  const candidates: IconCandidate[] = [];
  let manifestUrl: string | null = null;

  // HTMLRewriter to collect icon links from the page
  class IconCollector {
    element(element: Element) {
      const tagName = element.tagName;
      let href: string | null = null;
      let rel: string | null = null;
      let sizes: string | null = null;
      let type: string | null = null;

      if (tagName === 'link') {
        rel = element.getAttribute('rel');
        if (rel && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
          href = element.getAttribute('href');
          sizes = element.getAttribute('sizes');
          type = element.getAttribute('type');
        } else if (rel === 'manifest') {
          const manifestHref = element.getAttribute('href');
          if (manifestHref) {
            manifestUrl = new URL(manifestHref, targetUrl).toString();
          }
        }
      } else if (tagName === 'meta') {
        const property = element.getAttribute('property');
        if (property === 'og:image') {
          href = element.getAttribute('content');
          rel = 'og:image';
        }
      }

      if (href) {
        try {
          const score = scoreCandidate({ href, rel, sizes, type });
          candidates.push({
            url: new URL(href, targetUrl).toString(),
            rel,
            sizes,
            type,
            score,
          });
        } catch (e) {
          console.error(`Invalid icon URL found: ${href}`);
        }
      }
    }
  }

  // 1. Parse HTML to find icon candidates
  try {
    const response = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
    });
    
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const rewriter = new HTMLRewriter().on('link, meta', new IconCollector());
      await rewriter.transform(response).arrayBuffer();
    }
  } catch (e) {
    console.error(`Failed to fetch or parse HTML from ${targetUrl}:`, e);
  }

  // 2. Parse manifest.json if found
  if (manifestUrl) {
    try {
      const manifestResponse = await fetch(manifestUrl);
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();
        if (manifest.icons && Array.isArray(manifest.icons)) {
          for (const icon of manifest.icons) {
            if (icon.src) {
              const { src, sizes, type } = icon;
              const score = scoreCandidate({ href: src, rel: 'manifest-icon', sizes, type });
              candidates.push({
                url: new URL(src, manifestUrl).toString(),
                sizes,
                type,
                score,
                rel: 'manifest-icon',
              });
            }
          }
        }
      }
    } catch (e) {
      console.error(`Failed to fetch or parse manifest.json from ${manifestUrl}:`, e);
    }
  }

  // 3. Select the best candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    console.log("Found candidates:", candidates);
    return candidates[0].url;
  }

  // 4. Fallback to /favicon.ico
  try {
    const faviconUrl = new URL('/favicon.ico', targetUrl);
    const res = await fetch(faviconUrl.toString(), { method: 'HEAD' });
    if (res.ok) {
      return faviconUrl.toString();
    }
  } catch (e) {
    // Continue to next fallback
  }

  // 5. Final fallback to Google's favicon service
  return `https://www.google.com/s2/favicons?domain=${targetUrl.hostname}&sz=128`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let targetParam = url.searchParams.get('url');

    if (!targetParam) {
      return new Response('Missing url parameter', { status: 400 });
    }

    if (!targetParam.startsWith('http://') && !targetParam.startsWith('https://')) {
        targetParam = 'https://' + targetParam;
    }
    
    const targetUrl = new URL(targetParam);

    try {
      await wasmReady;

      const iconUrl = await findBestIcon(targetUrl);
      const iconResponse = await fetch(iconUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (!iconResponse.ok) {
        throw new Error(`Failed to fetch the final icon from ${iconUrl}, status: ${iconResponse.status}`);
      }

      const iconBuffer = await iconResponse.arrayBuffer();
      const contentType = iconResponse.headers.get('Content-Type') || 'image/png';

      let imageData;
      if (contentType.includes('png')) {
        imageData = await pngDecode(iconBuffer);
      } else if (contentType.includes('jpeg')) {
        imageData = await jpegDecode(iconBuffer);
      } else if (contentType.includes('webp')) {
        imageData = await webpDecode(iconBuffer);
      } else if (contentType.includes('ico') || contentType.includes('x-icon') || contentType.includes('vnd.microsoft.icon')) {
        const decodedIcos = decodeIco(iconBuffer);
        // From the multiple images in an ICO file, select the largest one.
        const bestIco = decodedIcos.reduce((a, b) => a.width > b.width ? a : b);
        // Convert it to the format required by @jsquash/resize.
        imageData = {
          data: new Uint8ClampedArray(bestIco.data),
          width: bestIco.width,
          height: bestIco.height,
        };
      } else {
        // If the content type is not supported for resizing, return the original icon
        return new Response(iconBuffer, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      const resizedImageData = await resize(imageData, { width: 32, height: 32 });
      const finalIconBuffer = await pngEncode(resizedImageData);
      
      return new Response(finalIconBuffer, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (error) {
      console.error(error);
      return new Response(`Could not find or process favicon for ${targetUrl}. Error: ${error}`, { status: 404 });
    }
  },
};

interface Env {}