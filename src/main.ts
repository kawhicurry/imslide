/// <reference types="@slidev/types/client" />
import { createApp } from 'vue';
import setupMain from '@slidev/client/setup/main.ts';
import App from './App.vue';
import appCss from './style.css?inline';

// Slide themes can contain global resets. Keep the workspace independent while
// the native renderer and all slide surfaces share their own isolated styles.
const shell = document.createElement('style');
shell.dataset.imslideShell = '';
shell.textContent = 'html,body,#root{margin:0!important;padding:0!important;width:100%;height:auto!important;min-height:100%;overflow:auto!important}#mermaid-rendering-container{position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none}';
document.head.append(shell);
const root = document.getElementById('root')!;
const shadow = root.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = appCss.replace(/:root\b/g, ':host') + '\n:host{display:block}button,textarea{font:inherit}';
const mount = document.createElement('div');
shadow.append(style, mount);
const app = createApp(App);
await setupMain(app);
app.mount(mount);
if (import.meta.hot) import.meta.hot.accept('./style.css?inline', module => {
  if (module) style.textContent = module.default.replace(/:root\b/g, ':host') + '\n:host{display:block}button,textarea{font:inherit}';
});
