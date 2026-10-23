import 'dotenv/config';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { defineConfig, type HmrContext } from 'vite';
import { resolveOptions, ViteSlidevPlugin, parser, createDataUtils } from '@slidev/cli';
import compatibility from './slides/vite.config.ts';

export default defineConfig(async ({ command }) => {
  const options = await resolveOptions({ entry: resolve(process.env.SLIDES_FILE || 'slides/slides.md'), routerMode: 'memory' }, command === 'build' ? 'build' : 'dev');
  // Compile static math/diagrams up front so adding either never reloads the workspace.
  options.data.features = {...options.data.features, katex:true, mermaid:true};
  options.utils = await createDataUtils(options);
  const fontLinks = options.utils.indexHtml.match(/<link[^>]+rel="stylesheet"[^>]*>/g)?.join('') || '';
  options.utils.indexHtml = (await readFile(resolve('index.html'), 'utf8')).replace('</head>', `${fontLinks}<script type="module" src="/@vite/client"></script></head>`);
  return {
    plugins: [{name:'imslide-prune-removed-styles',enforce:'post',handleHotUpdate(ctx: HmrContext) {
      return ctx.modules.filter(module => {
        const match=module.id?.match(/__slidev_(\d+)\.md\?vue&type=style&index=(\d+)/);
        if(!match)return true;
        const content=options.data.slides[Number(match[1])-1]?.content || '';
        return Number(match[2]) < (content.match(/<style(?:\s|>)/g)?.length || 0);
      });
    }}, {name:'imslide-reactive-config',enforce:'pre',transform(code: string,id: string) {
      if (id !== '/@slidev/configs' || !code.startsWith('export default ')) return;
      return `import {reactive} from 'vue'; const next=${code.slice('export default '.length)};
        const configs=import.meta.hot ? (import.meta.hot.data.configs ||= reactive({})) : reactive({});
        for(const key of Object.keys(configs)) if(!(key in next)) delete configs[key];
        Object.assign(configs,next);if(import.meta.hot)import.meta.hot.accept();export default configs;`;
    }}, {name:'imslide-fonts',transformIndexHtml: (html: string) => html.replace('</head>', `${fontLinks}</head>`)} ,...await ViteSlidevPlugin(options, {}, {async loadData(sources) {
      const loaded = await parser.load(options, options.entry, sources, 'dev');
      return {...loaded, features:{...loaded.features,katex:true,mermaid:true}, themeMeta: options.data.themeMeta, config: {...parser.resolveConfig(loaded.headmatter, options.data.themeMeta, options.entry), routerMode: 'memory' as const}};
    }}), ...(compatibility.plugins || [])],
    publicDir: resolve('public'),
    optimizeDeps: { entries: ['src/main.ts'], exclude: ['@shikijs/vitepress-twoslash/client'] },
    server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT || 5173), strictPort: true, hmr: {overlay:false}, proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT || 3001}`, ws: true } } },
    build: { outDir: resolve('dist'), emptyOutDir: true },
  };
});
