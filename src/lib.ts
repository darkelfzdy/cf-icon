import { Icon, ResponseInfo } from './types';

// This function is transplanted from the 'favicon-downloader' project.
// It fetches favicons from a given URL and returns ResponseInfo.
export const getFavicons = async ({ url, headers }: { url: string, headers?: Headers }): Promise<ResponseInfo> => {
  const newUrl = new URL(url); // Create a URL object to extract the host

  try {
    // Perform the fetch request with optional headers and redirection follow
    const response = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers
    });

    const body = await response.text();
    const responseUrl = new URL(response.url);

    // Regex to match <link> tags with "rel" containing "icon"
    const regex = /<link[^>]*rel=['"]?[^\s]*icon['"]?[^>]*?>/gi;
    const matches = Array.from(body.matchAll(regex));
    const icons: Icon[] = [];

    matches.forEach((match) => {
      const linkTag = match[0];

      // Extract href value
      const hrefMatch = linkTag.match(/href=['"]?([^\s>'"]*)['"]?/i);
      const href = hrefMatch ? hrefMatch[1] : null;

      // Extract sizes value
      const sizesMatch = linkTag.match(/sizes=['"]?([^\s>'"]*)['"]?/i);
      const sizes = sizesMatch ? sizesMatch[1] : null;

      if (href) {
        icons.push({
          sizes: sizes || 'unknown',
          href: (href.startsWith('http') || href.startsWith('data:image')) ? href : `${responseUrl.protocol}//${responseUrl.host}${/^\/.*/.test(href) ? href : `/${href}`}`
        });
      }
    });

    return {
      url: responseUrl.href,
      host: responseUrl.host,
      status: response.status,
      statusText: response.statusText,
      icons
    };
  } catch (error: any) {
    console.error(`Error fetching favicons: ${error.message}`);
    return {
      url: newUrl.href,
      host: newUrl.host,
      status: 500,
      statusText: 'Failed to fetch icons',
      icons: []
    };
  }
};

/**
 * Fetches a list of icons for a given domain by trying different strategies.
 * Logic transplanted and adapted from 'favicon-downloader' project.
 */
export async function fetchIconList(domain: string): Promise<Icon[]> {
  let allIcons: Icon[] = [];

  // 1. Try with HTTPS
  try {
    const data = await getFavicons({ url: `https://${domain}` });
    if (data.icons.length > 0) {
      allIcons.push(...data.icons);
    }
  } catch (error) {
    console.error('Error fetching HTTPS favicons:', error);
  }

  // 2. Try with HTTP (if HTTPS fails or returns no icons)
  if (allIcons.length === 0) {
    try {
      const data = await getFavicons({ url: `http://${domain}` });
      if (data.icons.length > 0) {
        allIcons.push(...data.icons);
      }
    } catch (error) {
      console.error('Error fetching HTTP favicons:', error);
    }
  }

  // 3. Fallback to third-party sources
  const sources = [
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source, { redirect: 'follow' });
      if (response.ok && response.status === 200) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.startsWith('image/')) {
          allIcons.push({ href: source, sizes: "unknown" });
        }
      }
    } catch (error) {
      console.error(`Error fetching from ${source}:`, error);
    }
  }
  
  // 4. If all attempts fail, add a placeholder SVG
  if (allIcons.length === 0) {
    const firstLetter = domain.charAt(0).toUpperCase();
    const svgContent = `
      <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#cccccc"/>
        <text x="50%" y="50%" font-size="48" text-anchor="middle" dominant-baseline="middle" fill="#000000">${firstLetter}</text>
      </svg>
    `;
    const base64Svg = `data:image/svg+xml;base64,${btoa(svgContent)}`;
    allIcons.push({
      sizes: '100x100',
      href: base64Svg
    });
  }

  return allIcons;
}