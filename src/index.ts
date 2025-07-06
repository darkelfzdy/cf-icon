import resize, { initResize } from '@jsquash/resize';
import { decode as pngDecode, encode as pngEncode } from '@jsquash/png';
import { init as initPng } from '@jsquash/png/decode';
import jpegDecode, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import jpegEncode, { init as initJpegEncode } from '@jsquash/jpeg/encode';
// Correct imports for webp decode and encode with their respective init functions
import webpDecode, { init as initWebpDecode } from '@jsquash/webp/decode';
import webpEncode, { init as initWebpEncode } from '@jsquash/webp/encode';
import decodeIco from 'decode-ico';
import { fetchIconList } from './lib';
import type { Icon, ScoredIcon } from './types';

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

// Calculates a score for a given icon based on format, size, and source
function calculateScore(icon: Icon): number {
  let score = 0;
  const href = icon.href.toLowerCase();

  // Rule 1: Format (from file extension or data URI)
  if (href.startsWith('data:')) score -= 1000;
  else if (href.endsWith('.svg')) score += 1000;
  else if (href.endsWith('.png')) score += 500;
  else if (href.endsWith('.ico')) score += 200;
  else score += 100; // Other image formats (jpg, etc.)

  // Rule 2: Size (as a bonus)
  if (icon.sizes && icon.sizes !== 'unknown') {
    const size = parseInt(icon.sizes.split('x')[0], 10);
    if (!isNaN(size)) {
      score += size;
    }
  }

  // Rule 3: Source reputation and keywords
  if (href.includes('apple-touch-icon')) score += 50;
  if (href.includes('google.com/s2/favicons')) score += 30;
  if (href.includes('icons.duckduckgo.com')) score -= 20;

  return score;
}

export default {
  async fetch(request: Request): Promise<Response> {
    await wasmReady;

    // 1. Parse domain from request URL
    const requestUrl = new URL(request.url);
    let path = decodeURIComponent(requestUrl.pathname.slice(1));

    if (!path) {
      return new Response("Please provide a domain or URL in the path, e.g., /example.com", { status: 400 });
    }

    if (!path.startsWith('http://') && !path.startsWith('https://')) {
      path = 'https://' + path;
    }

    let domain;
    try {
      domain = new URL(path).hostname;
    } catch (e) {
      return new Response("Invalid domain or URL provided: " + path, { status: 400 });
    }

    // 2. Fetch icon list using local logic
    const icons: Icon[] = await fetchIconList(domain);

    if (icons.length === 0) {
      return new Response("No icons found from API.", { status: 404 });
    }

    // 3. Score and sort icons
    const sortedIcons: ScoredIcon[] = icons
      .map(icon => ({ icon, score: calculateScore(icon) }))
      .sort((a, b) => b.score - a.score);

    // 4. Sequentially try to fetch and validate the best icon
    for (const { icon } of sortedIcons) {
      // Handle data URI separately
      if (icon.href.startsWith('data:image/svg+xml')) {
        try {
          const parts = icon.href.split(',');
          const b64 = parts[1];
          let svgText = atob(b64);
          // Modify SVG to set width and height
          svgText = svgText.replace(/<svg/i, `<svg width="40" height="40"`);
          return new Response(svgText, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
        } catch (e) {
          console.error("Failed to decode or modify data URI SVG:", e);
          continue;
        }
      }
      
      // Handle external URL icons
      try {
        const imageResponse = await fetch(icon.href, { redirect: 'follow' });

        if (!imageResponse.ok) continue;
        const contentType = imageResponse.headers.get('Content-Type') || '';
        if (!contentType.startsWith('image/')) continue;
        const contentLength = parseInt(imageResponse.headers.get('Content-Length') || '0', 10);
        if (contentLength > 0 && contentLength < 100) continue;

        // If SVG, modify and return
        if (contentType.includes('svg')) {
          let svgText = await imageResponse.text();
          // Add width and height attributes to the svg tag
          if (!svgText.match(/width=/i)) {
            svgText = svgText.replace(/<svg/i, `<svg width="40"`);
          }
          if (!svgText.match(/height=/i)) {
            svgText = svgText.replace(/<svg/i, `<svg height="40"`);
          }
          return new Response(svgText, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
        }

        // For bitmaps, decode, resize, and encode
        const imageBuffer = await imageResponse.arrayBuffer();
        let imageData: ImageData;

        if (contentType.includes('png')) {
          imageData = await pngDecode(imageBuffer);
        } else if (contentType.includes('jpeg')) {
          imageData = await jpegDecode(imageBuffer);
        } else if (contentType.includes('webp')) {
          imageData = await webpDecode(imageBuffer);
        } else if (contentType.includes('ico') || contentType.includes('x-icon')) {
          const decodedIcos = decodeIco(imageBuffer);
          const bestIco = decodedIcos.reduce((a, b) => a.width > b.width ? a : b);
          imageData = { data: new Uint8ClampedArray(bestIco.data), width: bestIco.width, height: bestIco.height, colorSpace: 'srgb' };
        } else {
          continue; // Skip unsupported bitmap formats
        }

        const resizedImageData = await resize(imageData, { width: 40, height: 40 });
        const finalIconBuffer = await pngEncode(resizedImageData); // Always encode to PNG for consistency

        return new Response(finalIconBuffer, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
        });

      } catch (error) {
        console.error(`Failed to process icon ${icon.href}:`, error);
      }
    }

    return new Response(`Could not find or process a valid icon for ${domain}.`, { status: 404 });
  },
};
