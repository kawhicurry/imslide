import { defineMermaidRendererSetup } from '@slidev/types';
import { render } from 'pele';

export default defineMermaidRendererSetup(() => (code, options) => render(code, {
  config: options,
  idPrefix: `pele-${crypto.randomUUID()}`,
  // Slides use a fixed canvas; preserve the direction authored in Markdown.
  autoDirection: false,
}).svg);
