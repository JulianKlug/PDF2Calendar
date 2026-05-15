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
  plugins: [requireDepartmentSlug()],
});
