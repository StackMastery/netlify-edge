// netlify/edge-functions/hello.ts
export default () => new Response("Hello from Netlify Edge!");
export const config = { path: "/test" };
