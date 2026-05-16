import { defineConfig, type Plugin } from "vite";

// VITE_DEPARTMENT_SLUG is baked into every person_hash. A missing slug
// silently corrupts every URL — fail the build, loudly, per docs/frontend-spec.md
// § Build-time environment.
function requireDepartmentSlug(): Plugin {
  return {
    name: "pdf2calendar:require-department-slug",
    apply: "build",
    configResolved() {
      const slug = process.env.VITE_DEPARTMENT_SLUG;
      if (!slug || slug.trim() === "") {
        throw new Error(
          "VITE_DEPARTMENT_SLUG is required at build time. Set it in your env, " +
            "e.g.: VITE_DEPARTMENT_SLUG=anesthesia-chuv bun run build",
        );
      }
    },
  };
}

export default defineConfig({
  root: "web",
  envPrefix: "VITE_",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  // Dev proxy: mirrors the production nginx layout so the browser POSTs to
  // same-origin /api/upload and Vite forwards it to the Bun server on :3001.
  // No CORS, no VITE_API_BASE_URL needed in dev. See docs/server-spec.md
  // § Deployment → nginx.
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  plugins: [requireDepartmentSlug()],
});
