import { defineConfig } from 'vite';

export default defineConfig({
  // Keep this module available to the compatibility transform rather than baking
  // the unguarded patch into Vite's dependency cache.
  optimizeDeps: { exclude: ['@shikijs/vitepress-twoslash/client'] },
  plugins: [{
    name: 'twoslash-floating-vue-compat',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').includes('/@shikijs/vitepress-twoslash/dist/client.mjs')) return;
      // Newer FloatingVue components no longer expose components.Popper.extends.
      // Only the optional drag suppression patch depends on that private API;
      // registration and normal tooltip behavior remain intact.
      const original = 'if (rest.length >= 2 && rest[0] === "VMenu")';
      if (!code.includes(original)) return;
      return {
        code: code.replace(original, 'if (rest.length >= 2 && rest[0] === "VMenu" && rest[1]?.components?.Popper?.extends?.methods)'),
        map: null,
      };
    },
  }],
});
