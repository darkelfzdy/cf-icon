
import resize from '@jsquash/resize';
// @ts-ignore
import wasmModule from '../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';

let wasmReady = WebAssembly.instantiate(wasmModule);

// 定义一个接口来规范候选图标的数据结构
interface IconCandidate {
  url: string;
  rel?: string | null;
  sizes?: string | null;
  type?: string | null;
  score: number;
}

// 评分函数，这是实现“高质量”选择的核心
function scoreCandidate(candidate: { href: string; rel: string | null; sizes: string | null; type: string | null }): number {
  let score = 0;
  const { href, rel, sizes, type } = candidate;

  // 1. 基于文件类型评分
  if (href.endsWith('.svg') || type === 'image/svg+xml') {
    score += 1000; // SVG 优先
  }

  // 2. 基于 rel 属性评分
  if (rel?.includes('apple-touch-icon')) {
    score += 500;
  } else if (rel?.includes('icon')) {
    score += 100;
  }

  // 3. 基于 sizes 属性评分
  if (sizes) {
    if (sizes === 'any') {
      score += 500; // 'any' 通常用于 SVG，给予高分
    } else {
      // 解析尺寸，例如 "180x180"
      const sizeMatch = sizes.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        score += parseInt(sizeMatch[1], 10); // 使用宽度作为分数的一部分
      }
    }
  }
  
  // og:image 作为备选，给予一个固定的分数
  if (rel === 'og:image') {
      score = 150; // 比大多数普通 icon 高，但比 apple-touch-icon 低
  }

  return score;
}

async function findBestIcon(targetUrl: URL): Promise<string> {
  const candidates: IconCandidate[] = [];

  // 处理器，用于收集所有可能的图标链接
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
        }
      } else if (tagName === 'meta') {
        const property = element.getAttribute('property');
        if (property === 'og:image') {
          href = element.getAttribute('content');
          rel = 'og:image'; // 自定义一个 rel 用于评分
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

  // 1. 解析 HTML 并收集所有候选图标
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

  // 2. 如果从 HTML 中找到了候选者，则进行评分和选择
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    console.log("Found candidates:", candidates);
    return candidates[0].url;
  }

  // 3. 如果 HTML 中没有找到，尝试 /favicon.ico
  try {
    const faviconUrl = new URL('/favicon.ico', targetUrl);
    const res = await fetch(faviconUrl.toString(), { method: 'HEAD' });
    if (res.ok) {
      return faviconUrl.toString();
    }
  } catch (e) {
    // 忽略错误，继续下一个后备方案
  }

  // 4. 最后的后备方案：使用 Google Favicon 服务
  return `https://www.google.com/s2/favicons?domain=${targetUrl.hostname}&sz=128`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let targetParam = url.searchParams.get('url');

    if (!targetParam) {
      return new Response('Missing url parameter', { status: 400 });
    }

    // Automatically add https:// if no protocol is present
    if (!targetParam.startsWith('http://') && !targetParam.startsWith('https://')) {
        targetParam = 'https://' + targetParam;
    }
    
    const targetUrl = new URL(targetParam);

    try {
      // Ensure wasm is ready before processing
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
      return new Response(`Could not find or process favicon for ${targetUrl}. Error: ${error}`, { status: 404 });
    }
  },
};

interface Env {}
