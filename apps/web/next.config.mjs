/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  async rewrites() {
    const gatewayUrl = process.env.GATEWAY_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || "http://127.0.0.1:8787";
    const sandboxUrl = process.env.SANDBOX_URL || "http://127.0.0.1:8788";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${gatewayUrl}/api/v1/:path*`,
      },
      {
        source: "/sandbox-api/:path*",
        destination: `${sandboxUrl}/:path*`,
      },
      {
        source: "/health",
        destination: `${gatewayUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
