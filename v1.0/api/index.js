const TARGET_DOMAIN = process.env.TARGET_DOMAIN;

if (!TARGET_DOMAIN) {
  console.error("TARGET_DOMAIN environment variable is not set");
}

const CONFIG = {
  timeout: 55000,
  maxRetries: 2,
  retryDelay: 300,
  enableCompression: true,
  keepAlive: true,
};

const SENSITIVE_HEADERS = [
  "x-vercel-deployment-url",
  "x-vercel-id",
  "x-vercel-proxy",
  "x-forwarded-for",
  "x-real-ip",
  "via",
  "cf-ray",
  "cf-connecting-ip",
];

function cleanHeaders(originalHeaders, host) {
  const cleaned = new Headers();
  
  for (const [key, value] of originalHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    
    if (SENSITIVE_HEADERS.includes(lowerKey)) continue;
    
    if (["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"].includes(lowerKey)) continue;
    
    if (lowerKey === "host") {
      cleaned.set("Host", host);
      continue;
    }
    
    if (lowerKey === "accept-encoding" && CONFIG.enableCompression) {
      cleaned.set("Accept-Encoding", "gzip, deflate, br");
      continue;
    }
    
    cleaned.set(key, value);
  }
  
  if (CONFIG.keepAlive) {
    cleaned.set("Connection", "keep-alive");
  }
  
  return cleaned;
}

function errorResponse(message, status = 500, details = null) {
  const body = JSON.stringify({
    error: message,
    status: status,
    timestamp: new Date().toISOString(),
    ...(details && { details }),
  });
  
  return new Response(body, {
    status: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function fetchWithRetry(url, options, maxRetries, delay, timeout) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (response.status < 500 || attempt > maxRetries) {
        return response;
      }
      
      console.warn(`Attempt ${attempt} failed with status ${response.status}, retrying...`);
      lastError = new Error(`HTTP ${response.status}`);
      
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      
      const isRetryable = err.name === "AbortError" || 
                          err.message.includes("fetch") ||
                          err.cause?.code === "ECONNRESET" ||
                          err.cause?.code === "ETIMEDOUT";
      
      if (isRetryable && attempt <= maxRetries) {
        console.warn(`Attempt ${attempt} failed: ${err.message}, retrying in ${delay * attempt}ms...`);
        await new Promise((r) => setTimeout(r, delay * attempt));
        continue;
      }
      
      break;
    }
  }
  
  throw lastError || new Error("Request failed after retries");
}

export default async function handler(req, res) {
  const url = new URL(req.url);
  const method = req.method;
  const isRetryable = method === "GET" || method === "HEAD";
  
  if (url.pathname === "/health" || url.pathname === "/_health") {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  
  if (!TARGET_DOMAIN) {
    console.error("Missing TARGET_DOMAIN environment variable");
    return errorResponse("Server configuration error: TARGET_DOMAIN not set", 500);
  }
  
  let upstreamPath = url.pathname;
  const queryString = url.search;
  
  upstreamPath = upstreamPath.replace(/\/+/g, "/");
  
  let upstreamUrl = `${TARGET_DOMAIN}${upstreamPath}${queryString}`;
  upstreamUrl = upstreamUrl.replace(/([^:]\/)\/+/g, "$1");
  
  const targetHost = new URL(TARGET_DOMAIN).host;
  
  const cleanedHeaders = cleanHeaders(req.headers, targetHost);
  
  let body = null;
  if (method !== "GET" && method !== "HEAD") {
    body = req.body;
  }
  
  try {
    const maxRetries = isRetryable ? CONFIG.maxRetries : 0;
    const upstreamResponse = await fetchWithRetry(
      upstreamUrl,
      {
        method: method,
        headers: cleanedHeaders,
        body: body,
        redirect: "follow",
      },
      maxRetries,
      CONFIG.retryDelay,
      CONFIG.timeout
    );
    
    const responseHeaders = new Headers();
    
    for (const [key, value] of upstreamResponse.headers.entries()) {
      const lowerKey = key.toLowerCase();
      
      if (SENSITIVE_HEADERS.includes(lowerKey)) continue;
      if (["content-encoding", "content-length", "connection", "keep-alive"].includes(lowerKey)) continue;
      if (lowerKey === "set-cookie") continue;
      
      responseHeaders.set(key, value);
    }
    
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Cache-Control", "no-store, private");
    responseHeaders.set("X-Accel-Buffering", "no");
    
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
    
  } catch (error) {
    console.error(`Proxy error for ${method} ${url.pathname}:`, error.message);
    
    if (error.name === "AbortError" || error.message.includes("timeout")) {
      return errorResponse("Upstream timeout", 504, { timeout: CONFIG.timeout });
    }
    
    if (error.message.includes("certificate") || error.message.includes("SSL")) {
      return errorResponse("Backend SSL certificate error", 502, {
        hint: "Check your backend TLS configuration",
      });
    }
    
    return errorResponse("Backend unreachable", 502, { cause: error.message });
  }
}

export const config = {
  runtime: "edge",
  regions: ["iad1", "cdg1", "hnd1"],
};
