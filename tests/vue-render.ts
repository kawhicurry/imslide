import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
export async function renderVue(file: string, props: Record<string,unknown>) {
  const server=await createServer({configFile:false,plugins:[vue()],server:{middlewareMode:true},appType:'custom'});
  try { const component=await server.ssrLoadModule(file);return await renderToString(createSSRApp(component.default,props)); }
  finally {await server.close();}
}
